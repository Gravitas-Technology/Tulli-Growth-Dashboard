// Vercel serverless function: GET /api/stats
// Reads Tulli's waitlist numbers from the Customer.io App API.
// The App API key stays on the server (env var CIO_APP_API_KEY) and never reaches the browser.

const BASE = process.env.CIO_REGION === "eu" ? "https://api-eu.customer.io" : "https://api.customer.io";
const FORM_LIVE = "2026-11-14"; // waitlist form went live
const SEG = {
  waitlist: Number(process.env.SEG_WAITLIST || 15),
  all: Number(process.env.SEG_ALL || 1),
  paying: Number(process.env.SEG_PAYING || 3),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One App API call, with retries on the 10-requests-per-second limit.
async function cio(path, { method = "GET", body } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.CIO_APP_API_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || 1;
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    return res.json();
  }
  throw new Error(`${method} ${path} -> rate limited`);
}

const count = async (id) => {
  const r = await cio(`/v1/segments/${id}/customer_count`);
  return Number(r.count) || 0;
};

// Day in Eastern time, e.g. "2026-11-21"
const etDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

async function signupsByDay() {
  // 1. Everyone in the waitlist segment (cio_id only, no personal data kept)
  const ids = [];
  let start = "";
  for (let page = 0; page < 50; page++) {
    const r = await cio(`/v1/segments/${SEG.waitlist}/membership?limit=30000${start ? `&start=${encodeURIComponent(start)}` : ""}`);
    for (const p of r.identifiers || []) if (p.cio_id) ids.push(p.cio_id);
    if (!r.next) break;
    start = r.next;
  }
  // 2. Their created_at, 100 people per request, a few requests at a time
  const days = {};
  const debug = { members: ids.length, rows: 0, withDate: 0, method: "bulk", shape: null, error: null };
  const since = Date.parse(`${FORM_LIVE}T05:00:00Z`);
  const add = (attrs) => {
    if (!attrs) return;
    // created_at may be seconds or an ISO string
    const raw = attrs.created_at ?? attrs._created_in_customerio_at;
    let ms = Number(raw) * 1000;
    if (!ms && typeof raw === "string") ms = Date.parse(raw);
    if (!ms) return;
    debug.withDate++;
    if (ms < since) return;
    const d = etDay.format(new Date(ms));
    days[d] = (days[d] || 0) + 1;
  };
  // A row can come back as {customer:{attributes}} or {attributes} depending on the API version
  const attrsOf = (row) => row?.customer?.attributes || row?.attributes || row?.customer || null;

  try {
    const chunks = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    for (let i = 0; i < chunks.length; i += 4) {
      const batch = chunks.slice(i, i + 4);
      const results = await Promise.all(
        batch.map((c) => cio("/v1/customers/attributes?id_type=cio_id", { method: "POST", body: { ids: c } }))
      );
      for (const r of results) {
        if (!debug.shape) debug.shape = Object.keys(r || {}).join(",") + " | " + Object.keys((r?.customers || [])[0] || {}).join(",");
        for (const row of r.customers || []) { debug.rows++; add(attrsOf(row)); }
      }
      if (i + 4 < chunks.length) await sleep(500);
    }
  } catch (e) {
    debug.error = String(e.message || e);
  }

  // Fallback: one person at a time (fine while the list is small)
  if (debug.withDate === 0 && ids.length && ids.length <= 400) {
    debug.method = "single";
    for (let i = 0; i < ids.length; i += 8) {
      const part = ids.slice(i, i + 8);
      const results = await Promise.all(
        part.map((id) => cio(`/v1/customers/${encodeURIComponent(id)}/attributes?id_type=cio_id`).catch((e) => ({ _err: String(e.message || e) })))
      );
      for (const r of results) {
        if (r._err) { debug.error = r._err; continue; }
        debug.rows++;
        add(attrsOf(r));
      }
      if (i + 8 < ids.length) await sleep(1000);
    }
  }
  return { days, debug };
}

export default async function handler(req, res) {
  const pass = process.env.DASHBOARD_PASSCODE;
  if (pass && req.headers["x-passcode"] !== pass) {
    res.status(401).json({ error: "passcode required" });
    return;
  }
  if (!process.env.CIO_APP_API_KEY) {
    res.status(500).json({ error: "CIO_APP_API_KEY is not set in Vercel" });
    return;
  }
  try {
    const [waitlist, all, paying] = await Promise.all([
      count(SEG.waitlist), count(SEG.all), count(SEG.paying),
    ]);
    const { days, debug } = await signupsByDay();
    // Shared cache: page loads within a minute reuse one Customer.io pull.
    // The Refresh button adds ?t=... and skips it.
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ at: new Date().toISOString(), waitlist, all, paying, days, debug });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
