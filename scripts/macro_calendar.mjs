/**
 * Checks the ForexFactory public weekly economic calendar feed for high-impact
 * USD events (CPI, FOMC, NFP, rate decisions, etc.) near the current moment.
 * Used to flag elevated-volatility windows for the hourly BTC verdict —
 * short-dated options positioning can flip fast around these releases.
 *
 * Best-effort by design: any fetch/parse failure returns elevated_risk:false
 * with a note, never throws — a missing calendar read should never block the
 * hourly analysis from running.
 */
const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

// How far back/forward (hours) counts as "nearby" for flagging elevated risk.
const LOOKBACK_HOURS = 1.5;
const LOOKAHEAD_HOURS = 3;

export async function checkMacroCalendar(now = new Date()) {
  try {
    const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const events = await res.json();

    const nowMs = now.getTime();
    const nearby = events
      .filter(e => e.country === 'USD' && e.impact === 'High')
      .map(e => {
        const eventMs = new Date(e.date).getTime();
        return { title: e.title, utc_time: new Date(eventMs).toISOString(), hours_from_now: (eventMs - nowMs) / 3_600_000 };
      })
      .filter(e => e.hours_from_now >= -LOOKBACK_HOURS && e.hours_from_now <= LOOKAHEAD_HOURS)
      .sort((a, b) => a.hours_from_now - b.hours_from_now);

    return {
      ok: true,
      elevated_risk: nearby.length > 0,
      events: nearby,
    };
  } catch (err) {
    return { ok: false, elevated_risk: false, events: [], note: `calendar unavailable: ${err.message}` };
  }
}

import { pathToFileURL } from 'url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkMacroCalendar().then(result => console.log(JSON.stringify(result, null, 2)));
}
