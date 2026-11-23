# nflprob

NFL prop engine: team model (win probability, implied points), anytime TD, rushing / receiving / passing yards with projected carries and receptions, DFS (Showdown and Classic) with lineup optimizers, season projections and an Accuracy tab with backtest-fitted calibration.

One of the owner's seven sibling apps (cfbprob, golfprob, hrprob, nascarprob, nflprob, nhlprob,
ufcprob), each its own repo and Vercel project, sharing the same stack and design kit.

## Layout

- Data: nflverse (player and team week stats, `games.csv` schedules with named QBs and lines),
  ESPN (schedule, rosters with injury designations).
- `lib/qb-starter.js`: this week's starting QB: nflverse's named QB unless ESPN lists him Out,
  Doubtful or IR, then the healthy roster QB with the most starts. Every tab uses it.
- `lib/roster-pool.js` `statsName()`: ESPN roster name → nflverse stats name (exact, then
  punctuation-insensitive, then suffix-insensitive when unique: ESPN "James Cook III" =
  nflverse "James Cook").
- Scoring models: `lib/td-scoring.js`, `lib/rush-scoring.js` (RB, and the starting QB at 3+
  carries a game), `lib/rec-scoring.js` (WR/TE, and RBs at 2+ targets), `lib/pass-scoring.js`,
  `lib/team-scoring.js`; `lib/calibration.js` (fitted calibrations, the 25/75 volume blend).
- DFS: `lib/dfs-projections.js`, `lib/dfs-optimizer.js`, `lib/classic-optimizer.js`.
- Book lines: `lib/espn-props.js` reads ESPN's pre-game player prop lines (core API propBets,
  keyed by ESPN athlete id, matched through the rosters); `lib/prop-ev.js` prices them against the
  model (TD EV; yardage over chance from a normal around the projection). `/api/props?week=N&view=lines`
  shows what the feed returned and what the parser skipped. Game lines prefer ESPN's current line,
  nflverse's file as the fallback (`withEspnLine` in `lib/vegas-lines.js`).
- `docs/golfprob-build-readout.md` used to sit here by mistake; golfprob's notes live in golfprob.
- The README's "Build order" section is out of date (yardage props, DFS and accuracy all exist).

## Open items

- Prop lines: checked on the live feed (Nov 2026). ESPN's propBets (DraftKings) give the line and
  opening line only, no prices; anytime TD items are empty. So yardage shows the book line and the
  model's gap to it, but there is no EV and no anytime TD line. Real EV needs a priced source
  (e.g. a paid odds API with a key); not decided. The weekly snapshot stores each line so the
  Accuracy tab's "Against the book" section measures model miss vs book miss.

- The QB fix relies on ESPN's injury report; if ESPN lags, the app can name an injured starter.
- DFS review after MIN@SF (2026 week 11, a 35-10 blowout; replayed leak-free on the real salary
  file): the 20 lineups were near-copies (McCaffrey 16-17/20, Purdy 15/20) because the 35% exposure
  cap lifted to 60% then 100% whenever the primary tier ran short; captains and forced correlation
  players ignored it. Mike Evans (back from 4 missed games) was projected 8.7 off one game in the
  window and scored 25.9. Fixes: the cap holds while value is relaxed (50% for good captains, 100%
  only as a last resort); a player who missed his team's latest game is projected from his season
  (backtest, 398 affected player-games: MAE 4.00 → 3.88); built-in DFS calibration
  (`DEFAULT_DFS_LINES` in `lib/calibration.js`, fitted on 8,270 player-games, each position better
  on held-out games) applies when the database has none. Replay of that slate: best lineup 85.2 →
  106.1, median 71.4 → 74.8. One game is noise; the per-player numbers are the evidence.
- DFS lineup-strategy backtest (370 games, 2025 wk 3-18 + 2026 wk 3-11, each as a Showdown slate,
  leak-free projections; salaries approximated from season DK averages because past salary files
  don't exist, so DK mispricing isn't captured). Measured vs the current optimizer, best of 20:
  stacking the favorite's DST with its QB/receiver captain +0.09 (noise, 54 better / 52 worse);
  upside weighting (projection + 0.3 / 0.6 × game-to-game spread) −0.25 / −0.73 (worse); no K/DST
  captains +0.30 (62 better / 39 worse, 95% CI −0.05 to +0.65): shipped as the Showdown default
  (`noCaptainPositions` in api/lineup-optimizer.js; a captain lock overrides it). The spread
  estimate itself is calibrated (17.1% of 9,204 player-games beat projection + spread) and is
  returned per player as `sd`; `stackDst` stays in the optimizer, off. The best lineups in
  hindsight have pricier captains ($7,956 vs our $6,601) and more ≤$3,000 punts (0.54 vs 0.32).
  Tested next (same 370 games, vs no-K/DST captains): star captain = top 4 projected +1.41 best of
  20 (95% CI +0.71 to +2.13; 176 better / 101 worse; 2025 +1.88, 2026 +0.54; avg lineup +9.2),
  top 6 +1.05, captain salary ≥ $7,000 +1.36; forcing a ≤$3,000 WR/TE into every lineup −2.5
  (alone or with a star captain). Shipped `captainTopN: 4` (a captain lock overrides it);
  `minCaptainSalary` and `cheapReceiver` stay in the optimizer, off. Known cost: a captain the
  model under-rates misses out (MIN@SF: Mike Evans, back from injury, was 6th).
- DFS projects QB rushing and RB receiving from plain recent averages (the props tabs use the
  matchup-adjusted models). Only switch DFS after the backtest shows the models are better.
- DFS availability comes from ESPN's rosters (`makeRosterNote` in `lib/dfs-projections.js`): a
  QB/RB/WR/TE/K who isn't on his team's ESPN roster (practice squad, released) or is Out / IR
  projects zero with the reason. A roster that fails to load checks nothing. A practice-squad
  player elevated for the game shows zero until ESPN moves him; the owner can lock him in.
- Players back from an absence (`returningPlayers` in `lib/roster-pool.js`): active on ESPN's
  roster, a real role this season (WR/TE 4+ targets, RB 8+ carries a game), missed the team's
  latest game. Receiving and anytime TD always include them, projected from the season, tagged
  "returning"; on receiving, teammates' target shares are scaled down by the returner's season
  share × the part of the recent window he missed (capped at 40%). DFS falls back to season usage
  for them. Not yet checked on past games. The rushing tab doesn't do this yet.
  `/api/props?view=player&name=Mike%20Evans` shows what the app knows about one player (ESPN roster
  entry, stats name, games, whether he counts as returning) when someone is missing.
- Players ruled out on ESPN are silently left off the props boards; a "ruled out" line was
  offered, not yet decided.
- Parked idea: a parlay analyzer (screenshot or typed slip graded against the model). The owner
  prefers it to stay in-app, without sending images to an outside service.
- Red zone carry share: the owner said keep the display as is.

## How to work in this repo

- **Commands:** `npm test` runs the test suite (synthetic data, no network). After editing
  `app.html`, extract its `<script>` block and run `node --check` on it.
- **Deploy:** Vercel deploys `main` automatically; there's no build step. Pushing straight to `main`
  is fine for this project. A hard refresh (Cmd+Shift+R) may be needed after a deploy.
- **Mobile scrolling:** on touch screens the document never scrolls: `html`/`body` are a fixed-height
  column (header, tab bar, then `#scroller`, which is the only thing that scrolls). Desktop keeps
  the sticky header and document scrolling. Why: measured on the owner's phone (Chrome on iOS,
  `?debug=scroll`), document scrolling made the browser toolbar slide in and out, resize the page
  mid-scroll and leave it resting ~120px down with the first rows under the pinned header. Sticky,
  fixed, unpinned, scroll anchoring off and a "finish the scroll" script all failed to fix that.
  Rules: don't reintroduce document-level scrolling or `position:sticky/fixed` bars on touch
  screens; scroll code must target `#scroller` as well as `window`; never run layout code on
  `resize`; sideways-scrolling boxes keep `overflow-y:hidden`. `/?debug=scroll` (scroll-debug.js)
  shows a live scroll log, and `/scrolltest.html` is a bare control page. The app page is served
  `Cache-Control: no-store` so phones never show an old copy.
- **Secrets:** the database URL and any keys live in Vercel's environment variables. Refer to
  variable names only; never put values in code, commits or messages.
- **Stack:** Vercel serverless functions in `api/` (one file per route; the Hobby plan caps a
  deployment at 12 functions and there are 12, so a new route must fold into an existing file), model
  and data code in `lib/`, the whole frontend in one `app.html` (vanilla JS, no framework), optional
  Postgres via `lib/db.js` (`DATABASE_URL`, `POSTGRES_URL` or the Prisma/Supabase variants).

## House rules (the owner's preferences)

- **Data first, honestly reported.** Model changes are checked on real past games (a leak-free
  replay: each day predicted only from earlier days) before they're called improvements, and
  results are reported as measured, including when a change doesn't help.
- **Public pages speak plainly.** No internal jargon, debug chips or "how we built it" notes on the
  page: that knowledge stays in the code and docs.
- **Picks lock.** Anything shown as the day's pick is saved write-once before the first start and
  never changes after; a database that doesn't answer writes nothing and shows "unconfirmed".
- **Never** put an AI model name in commits or code.
