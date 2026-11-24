# Tulli Growth Dashboard

A one-page dashboard that shows Tulli's waitlist numbers live from Customer.io. Anyone with the link sees live data; nobody needs a Customer.io login.

## How it works

- `public/index.html` is the dashboard. It loads data when opened, when you tap **Refresh**, when you pull down from the top on a phone, and when you come back to the tab.
- `api/stats.js` is a Vercel serverless function. It calls the Customer.io App API with a key stored in Vercel, so the key never reaches the browser.
- Page loads within a minute share one Customer.io pull. **Refresh** always pulls fresh.

## Deploy (about 5 minutes)

1. **Create a Customer.io App API key.** In Customer.io go to Settings > API Credentials > App API keys, then Create. Name it "Tulli dashboard", pick the Tulli workspace, and give it read-only access if offered. Copy the key.
2. **Put this folder in GitHub.** Make a new private repo (for example `tulli-growth-dashboard`) and upload these files.
3. **Import it in Vercel.** At vercel.com, choose Add New > Project, then pick the repo. Leave Framework as "Other" and leave the build settings empty.
4. **Add environment variables** (Settings > Environment Variables):
   - `CIO_APP_API_KEY`: the key from step 1 (required)
   - `DASHBOARD_PASSCODE`: a team passcode (optional; leave it out for open access)
5. **Deploy.** Open `https://<your-project>.vercel.app/api/stats`. You should see JSON with `"waitlist": 12` or more. Then open the main URL.

Optional: add a custom domain such as `stats.heytulli.ai` under Settings > Domains.

## Segments it reads

| Number | Customer.io segment | Env var to override |
| --- | --- | --- |
| 15 | Waitlist signup | `SEG_WAITLIST` |
| 1 | All Users | `SEG_ALL` |
| 3 | Paying Customers | `SEG_PAYING` |

## Security notes

- Never put the API key in `index.html` or commit it to GitHub. It lives only in Vercel's environment variables.
- The API returns counts only, never names or emails.
- Without `DASHBOARD_PASSCODE`, anyone who has the link can see the counts.

## Adding more metrics later

When the app starts sending events (`alpha_invite_sent`, `first_login`, `calendar_connected` …), create a segment for each funnel stage in Customer.io. Add its count in `api/stats.js`, then replace the matching "Not tracked" tile in `index.html`.
