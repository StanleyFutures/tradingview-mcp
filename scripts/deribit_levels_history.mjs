/**
 * Logs each computed Deribit option-level snapshot (timestamped) to a local
 * history file, and reconstructs per-level "segments" (value + time range)
 * so the levels can be drawn on the chart as a stepped history instead of a
 * single always-current line — lets you see how e.g. Gamma Wall moved over
 * time and how price reacted near it.
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { computeLevels, fetchOrderBookSummary, fetchFundingSummary } from './deribit_option_levels.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const HISTORY_FILE = join(DATA_DIR, 'option_levels_history.jsonl');

export const LEVEL_KEYS = ['strongest_call_wall', 'gamma_wall', 'gamma_flip', 'max_pain', 'strongest_put_wall'];

/**
 * Records a full snapshot: option levels (unchanged shape, used for chart
 * segments), plus IV skew, funding/perp-OI, and a live order-book read —
 * these three are logged for future pattern analysis but are NOT drawn as
 * chart segments (they're either continuous numbers or ephemeral snapshots,
 * not discrete strike levels, so a stepped-segment chart isn't the right fit).
 * Best-effort: if the order-book/funding fetch fails, the snapshot is still
 * recorded with those fields null rather than losing the whole snapshot.
 */
export async function recordSnapshot() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const levels = await computeLevels();

  let orderBook = null, funding = null;
  try { orderBook = await fetchOrderBookSummary(); } catch { /* best-effort */ }
  try { funding = await fetchFundingSummary(); } catch { /* best-effort */ }

  const snapshot = {
    ts: new Date().toISOString(),
    expiry: levels.expiry,
    spot: levels.spot,
    levels: Object.fromEntries(LEVEL_KEYS.map(k => [k, levels[k]])),
    iv: {
      atm_iv: levels.atm_iv,
      call_wing_iv: levels.call_wing_iv,
      put_wing_iv: levels.put_wing_iv,
      iv_skew: levels.iv_skew,
      iv_skew_weighted_near_atm: levels.iv_skew_weighted_near_atm,
    },
    order_book: orderBook,
    funding,
  };
  appendFileSync(HISTORY_FILE, JSON.stringify(snapshot) + '\n', 'utf8');
  return { snapshot, raw: levels };
}

export function loadHistory() {
  if (!existsSync(HISTORY_FILE)) return [];
  return readFileSync(HISTORY_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/**
 * Collapse consecutive same-value snapshots into segments.
 * A new expiry resets the run (different option series = not comparable).
 * Returns [{ value, start_ts, end_ts }], end_ts === null means "open" (still current).
 */
export function computeSegments(history, levelKey) {
  const segments = [];
  for (const entry of history) {
    const value = entry.levels[levelKey];
    if (value == null) continue;
    const last = segments[segments.length - 1];
    if (last && last.value === value && last.expiry === entry.expiry) {
      last.end_ts = null; // still open, this entry re-confirms the same value
    } else {
      if (last) last.end_ts = entry.ts; // previous segment closes exactly when this new reading landed
      segments.push({ value, start_ts: entry.ts, end_ts: null, expiry: entry.expiry });
    }
  }
  return segments;
}

export function allSegmentsByLevel(history) {
  const out = {};
  for (const key of LEVEL_KEYS) out[key] = computeSegments(history, key);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { snapshot } = await recordSnapshot();
  const history = loadHistory();
  console.log(JSON.stringify({ snapshot, history_count: history.length, segments: allSegmentsByLevel(history) }, null, 2));
}
