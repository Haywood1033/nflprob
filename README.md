# NFL Prop Probability Engine — nflprob

Same stack, design system, and modeling philosophy as the MLB HR engine (hrprob):
Vercel + Supabase Postgres + vanilla JS, navy #0a0e1a design system, signal-based scoring,
Bayesian regression toward league-average for small samples, self-correcting calibration
once real results come in, Wilson-score confidence tiers, locked signal badges, free data only.

## Build order (in progress)
1. ✅ **Team-level model** (win prob + implied points) — working end-to-end, verified against real nflverse data
2. ✅ **Anytime TD model** (RB/WR/TE) — working end-to-end, verified against real nflverse data
3. ⬜ **Yardage props** (rushing → receiving → passing) — next up
4. ⬜ **Accuracy tracking + badge tiers** — persistence layer scaffolded (`api/history.js`), needs
   real graded results before result-grading logic can be filled in

## What's real right now
- `lib/schedule.js` — ESPN's unofficial API for schedule, venues, and injuries (free, no auth).
  **Not yet verified live** — ESPN's domain isn't reachable from my sandbox, so this is
  untested against the real API response shape. Worth confirming the field paths
  (`ev.competitions[0].competitors`, etc.) match once it's actually deployed.
- `lib/weather.js` — Open-Meteo, same pattern as HR engine, all 32 stadium coords + dome flags
- `lib/nflverse.js` — team-level weekly stats. **Verified against the live file**: correct URL
  is `github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_{season}.csv`
  (not raw.githubusercontent.com — that was wrong in an earlier pass). The file is offense-only,
  one row per team per game; defense-allowed EPA is derived by looking up the opponent's row
  for the same `game_id`. No red-zone-rate column exists in this file — would need play-by-play
  data to add that signal later. Team abbreviations here are nflverse's own (`LA`, `WAS`), not
  ESPN's (`LAR`, `WSH`) — normalized in `toNflverseAbbr()`.
- `lib/player-stats.js` — player-level weekly stats from the same release family (`stats_player`
  tag). **Verified against the live file.** Uses a real quote-aware CSV parser — the naive
  comma-split that worked for the team file breaks here because `headshot_url` contains an
  embedded comma inside quotes (`f_auto,q_auto`).
- `lib/team-scoring.js` — Bayesian-regressed EPA/pace → implied points → win probability
- `lib/td-scoring.js` — Anytime TD model, position-specific (RB uses combined rushing+receiving
  complementary probability; WR/TE uses target-volume + TD-rate). Signal stack (usage/matchup/
  streak/game-script/role/confidence) → Elite/All-Star/Value badges, same thresholds as HR engine.
  **Needs real-season calibration** — right now several high-volume signals can still stack toward
  the 65% ceiling for legitimately elite players; this is expected to need the same kind of
  post-hoc correction the HR engine derived from ~1,900 tracked predictions, which we don't have yet.
- `api/team-model.js`, `api/props.js` — Vercel endpoints, 30-min cache. `api/props.js`'s player
  pool is **usage-based, not roster-confirmed** — it's not filtering out inactive/injured players
  for the upcoming week yet, since there's no real roster/injury fetcher wired in (same gap the
  HR engine solved with `lib/lineups.js`; NFL equivalent doesn't exist yet).
- `api/history.js` — Postgres persistence (Supabase-compatible connection string), weekly
  signal-lock + prediction storage. Result-grading (`action: 'results'`) is still stubbed.
- `app.html` — navy design system, Team Model and Anytime TD tabs both live and rendering
  from their respective APIs. Rushing/Receiving/Passing/Accuracy tabs are still placeholders.

## Market & risk signals (new)
Added in response to a "build these into the model" request after comparing against an
18-layer marketing description of someone else's prop engine. Each item below maps to one of
those named layers and was built only where real free data actually supports it — nothing here
is a label with no logic behind it, and the two gaps are called out as exactly that.
- `lib/vegas-lines.js` — **real market lines**, not mocked: nflverse's `schedules/games.csv`
  release (same file `lib/nflverse-games.js` already pulled for grading) carries
  `spread_line`/`total_line`/moneylines for every game, populated once a book has posted a
  number — **verified live**: populated from the current week through ~1 week out, genuinely
  blank further out (that's real market reality, not a bug). Sign convention derived and
  verified against real rows (see file comment). Also derives key-number "hook" risk (is the
  spread within 0.5 of 3/7/6/10/4/1/14), a standard 6-point teaser's crossings of those same
  numbers, and a blowout-risk flag off spread magnitude.
- `lib/qb-status.js` — **real backup-QB detection**, no roster/depth-chart source needed: the
  same games.csv file names each game's starting QB; a start is flagged "backup" when it's not
  this team's own season pass-attempt leader. **Verified live**: correctly flagged Tyler
  Huntley's start over Lamar Jackson's season-leading volume.
- `api/team-model.js` now actually uses `away_rest`/`home_rest` from that same file (real,
  numeric, available even for future weeks) and the QB-backup flag above, both fed into
  `lib/team-scoring.js`'s existing rest-day and QB-status multipliers — those multipliers
  existed in the model already but were never being passed real data until now. Each game's API
  response also carries a `market` object (spread/total/edge-vs-model/key-number/teaser/blowout/
  QB-status/rest-days/div-game) and `app.html`'s Team Model cards + drawer surface it.
- **Not built, and not free-data-feasible right now**: public betting/ticket-split "fade" data
  (Layer 3 of that other engine) has no free source — every real provider (Action Network,
  VSiN, sportsbook-reported handle) is paid. Defensive-scheme splits (man/zone rate, pressure
  scheme) aren't available free at useful granularity either.
- **Not built, but genuinely feasible later**: red-zone/inside-the-10 touch share and special
  teams/field-position signals both need nflverse's play-by-play release (a much larger
  per-season file than anything fetched today) — real, free, just a bigger separate build than
  this pass covered.

## What's NOT built yet
- Yardage prop distributions (rushing/receiving/passing) have scoring modules (`lib/rush-scoring.js`,
  `lib/rec-scoring.js`, `lib/pass-scoring.js`) and endpoints — check their own in-file notes for
  calibration status rather than trusting this line, which the rest of this README shows goes stale fast.
- Result-grading against actual box scores — `lib/grading.js` + `lib/nflverse-games.js` do this
  for real now (not stubbed, despite an earlier version of this README saying so)
- The full accuracy/calibration UI (HR engine's `htier` calibration display)
- Real-season calibration correction for the TD model (needs tracked results, like HR engine had)
- Play-by-play-derived signals (red-zone touch share, special teams) — see above
- Market/QB/rest signals above are wired into the Team Model tab only — the player-prop tabs
  (TD/rush/rec/pass) don't yet inherit the backup-QB or rest-day context

## Deploy
Same as HR engine:
1. Push to a GitHub repo
2. Import to Vercel
3. Set `DATABASE_URL` env var to your Supabase Postgres connection string
4. Deploy

## Local dev
```bash
npm install
npx vercel dev
# http://localhost:3000/app?week=1
```
