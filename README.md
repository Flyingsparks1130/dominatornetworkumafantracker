# Dominator Network Umamusume Fan Tracker

A static GitHub Pages tracker for the Dominator Network. The frontend reads the current and archived Chronogenesis JSON already stored in this repository.

## Frontend structure

- `index.html` — navigation home with network-wide statistics
- `clubs.html?id=<club-id>` — club directory with an in-page high-level club summary
- `club.html?id=<club-id>` — reusable individual-club Overview, Members, and Pace dashboard
- `rankings.html` — Rankings Home with the network pace chart and club rank history
- `rankings.html?section=clubs` — club rankings, top-five players by club, network critical members, and club health scores
- `rankings.html?section=individual` — individual member rankings (top 25 initially, expandable 10 at a time)
- `archives.html` — reserved Deeper Insights page
- `assets/css/app.css` — shared styling
- `assets/js/app.jsx` — shared React application
- `assets/js/snapshot-compat.js` — runtime fallback for the existing archive snapshot contract
- `config/frontend.json` — live frontend clubs and tier targets

## Change club targets

Edit `config/frontend.json`. Clubs inherit the target assigned to their tier:

```json
"tierTargets": {
  "S+": 330000000,
  "S": 250000000,
  "A+": 110000000,
  "A": 75000000,
  "B+": 30000000
}
```

To give one club a temporary exception, add `"targetOverride": 123000000` to that club. Without an override, every club in the same tier automatically shares the tier target.

The frontend and Chronogenesis updater both define 15 clubs. Dominate (`147185239`) is assigned to A+ and inherits the shared 110 million target. All A clubs inherit the shared 75 million target.

## Animated daily-report host

The animated report assigns each club a deterministic host for the day. The choice varies by club and date but remains stable when the same report is regenerated.

To pin a club to a preferred host, add an `animationHost` value to that club in `config/frontend.json`:

```json
"animationHost": "oguri-cap"
```

Supported values are `gentildonna`, `symboli-rudolf`, `narita-top-road`, `tm-opera-o`, `admire-vega`, `oguri-cap`, `mejiro-palmer`, `haru-urara`, and `matikanefukukitaru`. Remove the property to restore automatic daily selection.

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

### Archive safeguards and recovery

The month-end archive runs automatically three times on the first UTC day of each month. A club archive is locked once both `club_friend_history` and `club_daily_history` contain the final calendar day. Current-roster turnover is recorded as member-coverage metadata but does not block storage of an otherwise complete club payload.

Archive and refresh jobs share one concurrency group and retry push races. Month-end attempts receive a Bangkok first-day grace window while Chronogenesis finishes its final rows; after that window, the job fails visibly if an expected club is still missing. The refresh job retries temporary Chronogenesis failures and commits successful club updates before reporting any remaining failures.

To backfill a historical month, use the archive workflow inputs or run:

```bash
node scripts/archive-chronogenesis-complete-month.mjs --month YYYY-MM --source-ref COMMIT_SHA
```

The script refuses to backfill an older month from current live files. `COMMIT_SHA` must identify the historical update containing that month’s final-day payload.

## Local preview

Because the app fetches JSON, preview it through a local HTTP server rather than opening the HTML with a `file://` URL:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/`.

## Data architecture

The retired uma.moe/Playwright updater, root UMA JSON, and separate UMA rank-history files have been removed. The frontend now reads only Chronogenesis current and archive data.

## Frontend behavior notes

- Club Detail overview sparklines stop at the current Chronogenesis day, so future zero-filled days are not drawn.
- Switching clubs on `club.html` preserves the selected Overview, Members, or Pace tab.
- Club selection on `clubs.html` is page-local: clicking a directory row updates the high-level summary below without changing or inheriting the Club Detail selection.
- Deeper Insights is the final navigation destination, after Club Detail.
- The individual rankings list starts at 25 members, expands by 10, and can collapse back to the top 25 after the full list is shown.
