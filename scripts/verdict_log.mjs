/**
 * Appends each hourly BTC verdict to a running JSONL log and self-backfills
 * the outcome of past entries once enough time has passed (1h / 4h later),
 * by comparing this run's spot price against the spot logged at the time of
 * the older verdict. This builds an empirical accuracy track record for the
 * hourly-entry-analysis task without needing a separate evaluation job —
 * every run both logs itself and grades the runs from 1h/4h ago.
 *
 * Also reports whether the verdict direction changed since the previous run,
 * so the caller can decide whether this hour warrants a full report or just
 * a lightweight update (see btc-hourly-entry-analysis task).
 *
 * Usage: node verdict_log.mjs <path-to-payload.json>
 * Payload shape: { ts, spot, verdict, htf, macro_flag, macro_event, rr_summary }
 * verdict must be one of: "LONG" | "SHORT" | "NEUTRALNIE"
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const LOG_FILE = join(DATA_DIR, 'hourly_verdict_log.jsonl');

const THRESH_1H_PCT = 0.15;
const THRESH_4H_PCT = 0.4;

function gradeOutcome(verdict, pctMove, threshold) {
  if (verdict === 'LONG') {
    if (pctMove >= threshold) return 'hit';
    if (pctMove <= -threshold) return 'miss';
    return 'flat';
  }
  if (verdict === 'SHORT') {
    if (pctMove <= -threshold) return 'hit';
    if (pctMove >= threshold) return 'miss';
    return 'flat';
  }
  // NEUTRALNIE
  return Math.abs(pctMove) < threshold * 2 ? 'hit' : 'miss';
}

function computeStats(entries, key) {
  const graded = entries.filter(e => e[key] === 'hit' || e[key] === 'miss').slice(-100);
  const hits = graded.filter(e => e[key] === 'hit').length;
  const misses = graded.filter(e => e[key] === 'miss').length;
  const flats = entries.filter(e => e[key] === 'flat').slice(-100).length;
  const denom = hits + misses;
  return { n: graded.length, hits, misses, flats, hit_rate: denom > 0 ? +((hits / denom) * 100).toFixed(1) : null };
}

export function updateLog(payload) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const entries = existsSync(LOG_FILE)
    ? readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];

  const previousVerdict = entries.length ? entries[entries.length - 1].verdict : null;
  const changed = previousVerdict !== null && previousVerdict !== payload.verdict;

  const nowMs = new Date(payload.ts).getTime();
  let backfilled1h = 0, backfilled4h = 0;
  for (const e of entries) {
    const ageMs = nowMs - new Date(e.ts).getTime();
    if (e.outcome_1h == null && ageMs >= 3_600_000) {
      const pct = ((payload.spot - e.spot) / e.spot) * 100;
      e.outcome_1h = gradeOutcome(e.verdict, pct, THRESH_1H_PCT);
      e.outcome_1h_pct = +pct.toFixed(3);
      backfilled1h++;
    }
    if (e.outcome_4h == null && ageMs >= 14_400_000) {
      const pct = ((payload.spot - e.spot) / e.spot) * 100;
      e.outcome_4h = gradeOutcome(e.verdict, pct, THRESH_4H_PCT);
      e.outcome_4h_pct = +pct.toFixed(3);
      backfilled4h++;
    }
  }

  const newEntry = { ...payload, outcome_1h: null, outcome_1h_pct: null, outcome_4h: null, outcome_4h_pct: null };
  entries.push(newEntry);

  writeFileSync(LOG_FILE, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  return {
    changed_from_previous: changed,
    previous_verdict: previousVerdict,
    backfilled: { count_1h: backfilled1h, count_4h: backfilled4h },
    stats_1h: computeStats(entries, 'outcome_1h'),
    stats_4h: computeStats(entries, 'outcome_4h'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    console.error('Usage: node verdict_log.mjs <path-to-payload.json>');
    process.exit(1);
  }
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  console.log(JSON.stringify(updateLog(payload), null, 2));
}
