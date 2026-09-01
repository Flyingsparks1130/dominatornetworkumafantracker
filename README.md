# Dominator Network Umamusume Fan Tracker

A static GitHub Pages tracker for the Dominator Network. The frontend reads the current and archived Chronogenesis JSON already stored in this repository.

## Frontend structure

- `index.html` — network home
- `clubs.html` — club directory
- `club.html?id=<club-id>` — reusable individual-club dashboard
- `rankings.html` — network analysis and rankings
- `archives.html?month=YYYY-MM` — archive entry point
- `assets/css/app.css` — shared styling
- `assets/js/app.jsx` — shared React application
- `assets/js/snapshot-compat.js` — runtime fallback for the existing archive snapshot contract
- `config/frontend.json` — live frontend clubs and tier targets

## Change club targets

Edit `config/frontend.json`. Clubs inherit the target assigned to their tier:

```json
"tierTargets": {
  "S+": 300000000,
  "S": 250000000,
  "A+": 90000000,
  "A": 70000000,
  "B+": 30000000
}
```

To give one club a temporary exception, add `"targetOverride": 123000000` to that club. Without an override, every club in the same tier automatically shares the tier target.

## Protected Chronogenesis boundary

The following operational paths remain the existing source of truth and should not be casually refactored:

- `data/chronogenesis/**`
- `.github/workflows/archive-chronogenesis.yml`
- `.github/workflows/refresh-chronogenesis-json.yml`
- `scripts/archive-chronogenesis-complete-month.mjs`
- `scripts/chronogenesis.clubs.config.json`
- `scripts/snapshot-chronogenesis-config.mjs`
- `scripts/update-chronogenesis.mjs`

`index.html` intentionally retains a non-executing `chronogenesis-snapshot-compat` block because the existing snapshot script parses those declarations. The browser uses `config/frontend.json` for the live site.

## Local preview

Because the app fetches JSON, preview it through a local HTTP server rather than opening the HTML with a `file://` URL:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/`.

## Data architecture

The retired uma.moe/Playwright updater, root UMA JSON, and separate UMA rank-history files have been removed. The frontend now reads only Chronogenesis current and archive data.
