// Vercel serverless function: GET /api/stats
// Reads Tulli's waitlist numbers from the Customer.io App API.
// The App API key stays on the server (env var CIO_APP_API_KEY) and never reaches the browser.

const BASE = process.env.CIO_REGION === "eu" ? "https://api-eu.customer.io" : "https://api.customer.io";
const FORM_LIVE = "2026-11-14"; // waitlist form went live
const SEG = {
  waitlist: Number(process.env.SEG_WAITLIST || 15),
  main: Number(process.env.SEG_MAIN || 18),
  ces: Number(process.env.SEG_CES || 17),
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
  const since = Date.parse(`${FORM_LIVE}T05:00:00Z`);
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  for (let i = 0; i < chunks.length; i += 4) {
    const batch = chunks.slice(i, i + 4);
    const results = await Promise.all(
      batch.map((c) => cio("/v1/customers/attributes?id_type=cio_id", { method: "POST", body: { ids: c } }))
    );
    for (const r of results) {
      for (const row of r.customers || []) {
        const sec = Number(row?.customer?.attributes?.created_at);
        if (!sec || sec * 1000 < since) continue;
        const d = etDay.format(new Date(sec * 1000));
        days[d] = (days[d] || 0) + 1;
      }
    }
    if (i + 4 < chunks.length) await sleep(500);
  }
  return days;
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
    const [waitlist, main, ces, all, paying] = await Promise.all([
      count(SEG.waitlist), count(SEG.main), count(SEG.ces), count(SEG.all), count(SEG.paying),
    ]);
    const days = await signupsByDay();
    // Shared cache: page loads within a minute reuse one Customer.io pull.
    // The Refresh button adds ?t=... and skips it.
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ at: new Date().toISOString(), waitlist, main, ces, all, paying, days });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
