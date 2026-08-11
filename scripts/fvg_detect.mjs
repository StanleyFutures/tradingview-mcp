/**
 * Fair Value Gap (FVG) detection, ICT-style 3-candle imbalance.
 * Bullish FVG: bars[i-1].high < bars[i+1].low -> gap zone [bars[i-1].high, bars[i+1].low]
 * Bearish FVG: bars[i-1].low > bars[i+1].high -> gap zone [bars[i+1].high, bars[i-1].low]
 * A gap is "filled" the first time a later bar's range overlaps the gap zone at all.
 *
 * Usage: node scripts/fvg_detect.mjs <bars.json> <timeframe_label>
 * <bars.json> must be `{ bars: [{time, open, high, low, close, volume}, ...] }` (ascending time).
 * Prints JSON: { timeframe, fvg_count, fvgs: [...] } to stdout.
 */
import { readFileSync } from 'fs';

export function detectFVGs(bars, timeframeLabel) {
  const fvgs = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const c1 = bars[i - 1];
    const c2 = bars[i];
    const c3 = bars[i + 1];

    let type = null, gapLow = null, gapHigh = null;
    if (c1.high < c3.low) { type = 'bullish'; gapLow = c1.high; gapHigh = c3.low; }
    else if (c1.low > c3.high) { type = 'bearish'; gapLow = c3.high; gapHigh = c1.low; }
    if (!type) continue;

    let filled = false, filled_at = null;
    for (let j = i + 2; j < bars.length; j++) {
      const b = bars[j];
      if (b.low <= gapHigh && b.high >= gapLow) { filled = true; filled_at = b.time; break; }
    }

    fvgs.push({
      timeframe: timeframeLabel,
      type,
      gap_low: gapLow,
      gap_high: gapHigh,
      formed_at: c1.time, // left edge: start of candle 1
      confirmed_at: c3.time, // right edge of the 3-candle pattern
      filled,
      filled_at,
      mid_candle_time: c2.time,
    });
  }
  return fvgs;
}

if (process.argv[1] && process.argv[1].endsWith('fvg_detect.mjs') && process.argv[2]) {
  const barsFile = process.argv[2];
  const timeframeLabel = process.argv[3] || '?';
  const { bars } = JSON.parse(readFileSync(barsFile, 'utf8'));
  const fvgs = detectFVGs(bars, timeframeLabel);
  console.log(JSON.stringify({ timeframe: timeframeLabel, fvg_count: fvgs.length, fvgs }, null, 2));
}
