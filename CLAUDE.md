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
- DFS projects QB rushing and RB receiving from plain recent averages (the props tabs use the
  matchup-adjusted models). Only switch DFS after the backtest shows the models are better.
- DFS reads DK's `Status` column only as OUT/IR/Doubtful/Suspended; codes like "O" aren't read,
  and the standard DK export has no status column.
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
- **Mobile scrolling:** never run layout code on `resize`: phones and tablets resize the page
  whenever the address bar slides during a scroll. A Nov 3 rotation fix that hid and redrew the
  page on every resize broke scrolling until Nov 12; the rotation fix now runs on orientation
  changes only and never hides the page. The pinned header and tab bar are as they were before.
  Every sideways-scrolling box (game strip, tab bar, tables) sets `overflow-y:hidden`: with
  `overflow-x:auto` alone it can also scroll vertically by a pixel or two, and on a touch screen
  an upward swipe then scrolls the box, not the page, leaving its top cut off.
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
