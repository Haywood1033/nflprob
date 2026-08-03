# NFL Prop Probability Engine — nflprob

Same stack, design system, and modeling philosophy as the MLB HR engine (hrprob):
Vercel + Supabase Postgres + vanilla JS, navy #0a0e1a design system, signal-based scoring,
Bayesian regression toward league-average for small samples, self-correcting calibration
once real results come in, Wilson-score confidence tiers, locked signal badges, free data only.

## Build order (in progress)
1. ✅ **Team-level model** (win prob + implied points) — scaffolded, working end-to-end
2. ⬜ **Anytime TD model** (all positions) — next up
3. ⬜ **Yardage props** (rushing → receiving → passing)
4. ⬜ **Accuracy tracking + badge tiers** — persistence layer scaffolded (`api/history.js`), needs
   the props layer before result-grading can be filled in

## What's real right now
- `lib/schedule.js` — ESPN's unofficial API for schedule, venues, and injuries (free, no auth)
- `lib/weather.js` — Open-Meteo, same pattern as HR engine, all 32 stadium coords + dome flags
- `lib/nflverse.js` — team-level weekly stats from nflverse-data's public GitHub releases (free).
  **Needs verification**: the exact CSV filenames/columns in `TEAM_WEEK_URL` are my best
  recollection of nflverse's release structure, not a live-tested fetch. First real task when
  we resume: hit that URL for real and confirm the column names match (`offense_epa_play` etc.
  may need renaming).
- `lib/team-scoring.js` — the actual model: Bayesian-regressed EPA/pace toward league average,
  home field, QB status, rest days, weather, red zone rate → implied points → win probability
- `api/team-model.js` — Vercel endpoint wiring the above together, 30-min cache
- `api/history.js` — Postgres persistence (works with Supabase's connection string as-is),
  weekly signal-lock + prediction storage. Result-grading (`action: 'results'`) is stubbed —
  needs box-score fetching logic once we know what a "prop prediction" record looks like
- `app.html` — navy design system tokens copied exactly, header/tabs shell, Team Model tab
  is live and rendering from the API. Other tabs (TD/Rush/Rec/Pass/Accuracy) are placeholders.

## What's NOT built yet
- Anytime TD signal stack (7-signal badge system, position-specific)
- Yardage prop distributions
- Result-grading against actual box scores
- The full accuracy/calibration UI (HR engine's `htier` calibration display)
- Confidence-interval (Wilson score) tiers for props — mechanism is proven in HR engine,
  just needs routes/carries/attempts as the sample-size anchor instead of PA

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
