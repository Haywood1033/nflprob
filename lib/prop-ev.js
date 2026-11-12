// lib/prop-ev.js — prices the model's props against a sportsbook line. Pure functions, no fetching.
//
// Anytime TD: the model's probability against the book's price → expected value per unit staked.
// Yardage: the model's projection and floor–ceiling band (±1 SD) give a normal estimate of the
// chance he goes over the book's line; that against the over and under prices → EV per side.
// The normal shape is an approximation (yardage is skewed right), and none of this has been
// checked on past lines yet: the weekly snapshot stores the line so the record can measure it.

// American odds ("+150", "-115", "EVEN", 150) → number, or null.
function parseAmerican(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\s*(even|ev)\s*$/i.test(v)) return 100;
  const n = Number(String(v).replace(/[^\d+.-]/g, ''));
  return Number.isFinite(n) && Math.abs(n) >= 100 ? n : null;
}
const americanToDecimal = a => (a == null ? null : a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const americanToProb = a => (a == null ? null : a < 0 ? -a / (-a + 100) : 100 / (a + 100));

// Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7).
function normalCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

const round = (v, d = 1) => (v == null ? null : +v.toFixed(d));

// probPct: the model's anytime TD chance in percent. price: American odds for "yes".
function priceAnytimeTd(probPct, price) {
  const a = parseAmerican(price);
  if (a == null || probPct == null) return null;
  const p = probPct / 100;
  return { price: a, bookProb: round(americanToProb(a) * 100), ev: round((p * americanToDecimal(a) - 1) * 100) };
}

// A yardage gap counts as "far off" the book when it's at least 10 yards and 20% of the line.
function isFarOff(diff, line) { return Math.abs(diff) >= Math.max(10, 0.2 * Math.abs(line)); }

function priceYards({ projected, floor, ceiling }, { line, overPrice, underPrice }) {
  if (projected == null || line == null) return null;
  const halfBand = floor != null && ceiling != null ? (ceiling - floor) / 2 : 0;
  // The band can be squeezed by the zero floor; never let the spread fall below 20% of the mean.
  const sd = Math.max(halfBand, 0.2 * Math.max(projected, line), 5);
  const pOver = 1 - normalCdf((line - projected) / sd);
  const o = parseAmerican(overPrice), u = parseAmerican(underPrice);
  const evOver = o != null ? (pOver * americanToDecimal(o) - 1) * 100 : null;
  const evUnder = u != null ? ((1 - pOver) * americanToDecimal(u) - 1) * 100 : null;
  let side = null, ev = null;
  if (evOver != null || evUnder != null) {
    side = (evUnder == null || (evOver != null && evOver >= evUnder)) ? 'over' : 'under';
    ev = side === 'over' ? evOver : evUnder;
  }
  // The book's own over chance with the vig taken out, when both sides are priced.
  const io = americanToProb(o), iu = americanToProb(u);
  const diff = projected - line;
  return {
    line, overPrice: o, underPrice: u,
    diff: round(diff), farOff: isFarOff(diff, line),
    modelOver: round(pOver * 100), bookOver: io != null && iu != null ? round(io / (io + iu) * 100) : null,
    side, ev: round(ev),
  };
}

module.exports = { parseAmerican, americanToDecimal, americanToProb, normalCdf, priceAnytimeTd, priceYards, isFarOff };
