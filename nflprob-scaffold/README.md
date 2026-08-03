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

## What's NOT built yet
- Roster/injury confirmation for the props player pool (biggest real gap right now)
- Yardage prop distributions (rushing/receiving/passing)
- Result-grading against actual box scores
- The full accuracy/calibration UI (HR engine's `htier` calibration display)
- Real-season calibration correction for the TD model (needs tracked results, like HR engine had)

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
