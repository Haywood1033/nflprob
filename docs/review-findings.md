# Code and design review: findings

Reviewed at commit `84985d0` (2026-11-10) and rechecked against `4bd5eed`; every line reference
below still matches. These findings come from reading the code, nothing was run. Covered in
full: the game, TD, rush, pass, calibration, backtest and grading modules and the main
endpoints. `app.html` was keyword-searched rather than read line by line. Not reviewed: the DFS
optimizers and projections, `lib/rec-scoring.js`, `lib/roster*.js`, `lib/red-zone.js`,
`api/season.js`.

House rule applies: any model change in sections 2 and 3 gets checked with the leak-free
backtest (`/api/backtest`) before it's called an improvement, and the result is reported as
measured. The four bugs in section 1 are plain correctness fixes.

Work through it in order: 1 → 3 → 2 → 4.

---

## 1. Bugs (wrong numbers today)

### 1.1 Model-vs-market margin edge has the wrong sign
- **Where:** `api/team-model.js:99`
- **Now:** `homeMarginEdge: model.diff - market.homeSpread`
- **Why it's wrong:** `market.homeSpread` is already a bettor-style line (negative = home
  favored), so the home margin the market expects is `-homeSpread`. Example: model has the home
  team by 6, market has home -7. The edge should be -1 (market likes home more), but the code
  gives 6 - (-7) = +13, and the Slate drawer reads "Home by 13 more pts".
- **Fix:** `model.diff + market.homeSpread`. The backtest is already right:
  `lib/backtest.js:205` compares `r.diff` with the raw `spread_line`, which equals the expected
  home margin.
- **Test:** add a unit test for the edge with the example above.

### 1.2 Weather is today's forecast, not game day's
- **Where:** `api/team-model.js:56`:
  `fetchAllWeather(new Date().toLocaleDateString('en-CA'), homeTeams, {})`
- **Why it's wrong:** the game date is today's date and the kickoff map is empty, so every
  game gets today's ~1 PM reading at the home stadium (`lib/weather.js:92`). On a Tuesday that's
  a forecast for the wrong day, and it feeds the wind/cold multipliers in
  `lib/team-scoring.js:38-43`. Neutral-site and international games get the home team's
  stadium (and the +1.0 home-field point).
- **Fix:** group games by their own date (ET) from the schedule's `date`; pass each game's
  kickoff hour; use the nflverse `roof` field (already in `getMarketContext`) for dome status;
  skip home field when the game is at a neutral site (ESPN `neutralSite` on the competition).
- **Note:** `lib/weather.js` reads the forecast hour as a local wall clock (`timezone=auto`)
  against an ET kickoff string, so West Coast kickoffs are off by three hours. Convert the
  kickoff to the stadium's local time, or request `timezone=America/New_York`.

### 1.3 Season year is wrong in January
- **Where:** `api/team-model.js:28`, `api/props.js:83`, `api/rush-props.js:49`,
  `api/rec-props.js:48`, `api/pass-props.js:49`, `api/season.js:54`:
  `req.query.year || new Date().getFullYear()`
- **Why it's wrong:** the client never sends `year`, so weeks 17-18 (played in January 2027)
  request the 2027 season. Separately, each endpoint's in-memory cache is keyed on week only, so
  a week number from a different year can be served from cache.
- **Fix:** take the season from `/api/current-week` (ESPN's `season.year`) and send it from the
  client on every call; server fallback = the NFL season year (`month < 3 ? year - 1 : year`).
  Key every cache on `year + week`.

### 1.4 Inactive players graded as anytime TD misses
- **Where:** `lib/grading.js:22`
- **Now:** no stat line → `hit: false` for `anytime_td`.
- **Why it's wrong:** books void an anytime TD bet when the player doesn't play, and the
  backtest drops these rows (`lib/backtest.js:20`, `:157`). The live track record therefore
  reads worse than the backtest for no real reason.
- **Fix:** return `hit: null`, `void: true` with the same note; exclude voids from hit rates.

---

## 2. Accuracy gaps (model)

### 2.1 Props ignore the market and the game context
- **Where:** `api/props.js:127`, `api/rush-props.js:85`, `api/rec-props.js:83`,
  `api/pass-props.js:89`: `buildGameModel(homeEff, awayEff, {})`
- **Problem:** no QB status, rest, weather or calibration, so the team totals the props use
  differ from the ones on the Slate tab, and a backup QB doesn't lower his teammates' props.
- **Fix:** build one shared game context (the same thing `api/team-model.js` builds) and reuse
  it. Then try blending in the market-implied team total when a line exists:
  `home = total/2 - homeSpread/2`, `away = total/2 + homeSpread/2`. Likely the biggest single
  accuracy gain available; backtest the blend weight.

### 2.2 Game script uses team total instead of expected margin
- **Where:** `lib/pass-scoring.js:87` (attempts scale up with implied points),
  `lib/rush-scoring.js:113`
- **Problem:** teams that lead throw less and run more. A big favorite gets more pass attempts
  here, which is backwards.
- **Fix:** scale pass attempts down and carries up with the expected margin (model diff or
  market spread); keep a smaller total-based term for overall play volume. Backtest it.

### 2.3 Team ratings are thin
- **Where:** `lib/nflverse.js:78-113`, `lib/team-scoring.js`
- EPA isn't opponent-adjusted (a team that played three bad defenses looks elite).
- Five-game window with K = 2 shrinkage; consider a longer window with recency weights and a
  prior from last season's rating early in the year.
- Home field is a flat +1.0 (`team-scoring.js:29`); league average is hard-coded to 22
  (`LG_PPG`, and repeated as `22.0` in the TD, rush and pass models); a backup QB is a flat
  -15% (`team-scoring.js:30`). Fit these from the backtest instead.

### 2.4 TD multipliers stack on the probability
- **Where:** `lib/td-scoring.js:113-134`
- **Problem:** matchup (up to 1.25) × team total (1.25) × red zone (1.3) × hot streak (1.12)
  can multiply a probability by about 2.3 before the soft cap. Multiplying probabilities is
  also wrong at the high end.
- **Fix:** apply adjustments to the expected TD count (λ), then `p = 1 - e^-λ`. Drop or shrink
  the hot-streak term: recent TDs are already in the rate, so it double-counts. Shrink the
  defense-allowed rate toward the league (it's at most five games, unregressed).

### 2.5 League constants are guesses
- **Where:** `LG` and `LG_TDS_ALLOWED` / `LG_INSIDE10_SHARE` in `lib/td-scoring.js`, `LG_YPA`,
  `LG_YPC`, the `K_*` values. The file comments say "estimated, not fit".
- **Fix:** compute them from the prior two seasons the backtest already loads.

### 2.6 Yardage has no distribution
- **Where:** `lib/rush-scoring.js:119-121`, `lib/pass-scoring.js:110-112`
- **Problem:** floor/ceiling is ±1 SD from at most five games, so the app can't answer "chance
  he goes over 62.5". Volume (carries, attempts) isn't regressed, so one or two games after a bye
  or injury drive the projection.
- **Fix:** shrink the per-player SD toward a position-level SD; model yards as a skewed
  distribution (e.g. log-normal or a gamma on volume × efficiency) and expose
  `P(over line)`. Regress volume toward a role prior.

### 2.7 Players matched by display name
- **Where:** `computePlayerUsage` (`lib/td-scoring.js:22`) filters by name only, not team;
  grading keys on name + team (`lib/grading.js:20`).
- **Fix:** key on `player_id` (GSIS) everywhere it exists; fall back to name only when it
  doesn't.

---

## 3. Track-record integrity

### 3.1 The weekly snapshot is first-visitor-wins
- **Where:** `app.html:860-875` (`maybeSnapshotWeek`), `api/history.js:60-82`
- **Problem:** the browser posts the snapshot, whenever someone first opens the app that week,
  to an unauthenticated endpoint with `Access-Control-Allow-Origin: *`. Anyone can write the
  record, and its timing (and so what it knew) varies week to week. This conflicts with the
  "picks lock before the first start" rule.
- **Fix:** move the save to a server cron (Vercel Cron, like `api/cron-grade.js`) that runs
  before the first kickoff of the week, then again before each later kickoff window for games not
  yet started. Protect the write with `CRON_SECRET`. Drop the client POST.

### 3.2 The live record uses hit rate
- **Problem:** hit rate says little for a 30% TD probability, and yardage "hit" = inside the
  floor-ceiling band. Totals "hit" = within 7 points.
- **Fix:** show Brier score, log loss and calibration bins for the live record, the same
  metrics the backtest already reports. Store the closing line and price with each pick so the
  record can also show results against the market.

---

## 4. UI/UX

1. **Nothing is priced.** Best Plays is "what should I bet" but ranks by signal count and
   projection size (`app.html:1174-1213`, e.g. `normalizedValue: p.prob/65*100`). Show fair odds
   (American) beside every percentage, and let the user enter a line and price to get the edge,
   as golfprob does. Rank Best Plays by edge once a price is entered.
2. **Badge names mislead.** "Value Play" is the lowest signal tier, not a price judgment.
   "Sharp Play" requires a hot streak plus a good matchup, both of which books price in. Most
   signals measure volume, so badges mostly say "high-usage player". Rename the tiers to describe
   confidence, and keep "value" for priced edges only.
3. **Eleven top-level tabs.** Fold Anytime TD / Rushing / Receiving / Passing into one Props tab
   with a market toggle.
4. **Tables can't be sorted or searched.** Add sortable headers and a player search box. Tabs and
   expandable rows are click-only `div`/`tr` elements: make them buttons or give them
   `role`, `tabindex` and Enter/Space handling.
5. **Warnings hide in `title` tooltips** (e.g. the unmodeled-teammate ⚠ at `app.html:1059`),
   which don't show on touch. Put them in the row or the drawer.
6. **No state in the URL or storage.** Tab, filters, parlay legs and DFS uploads vanish on reload,
   and Back doesn't work. Put tab and filters in the URL; keep parlay legs in `localStorage`
   (wrapped in try/catch).
7. **Status shows "Live / Cached" with no time.** Show "Data through Week X · updated N min ago".
8. **Small text.** 73 CSS rules set text at 11px or below; golfprob's floor is 12px.
9. **Unescaped names in `innerHTML`.** Player names (including from uploaded DK files) are
   inserted raw. Escape them (`ppEsc` already exists in the player panel; use it everywhere).
10. **The totals edge label is ambiguous.** "+2.5 vs model" (`app.html:984`) doesn't say which
    side is higher, and only overs are highlighted. Say "Model 2.5 over the market" or
    "under", and style both.
