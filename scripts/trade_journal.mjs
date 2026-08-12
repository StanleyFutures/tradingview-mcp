/**
 * Trade journal: records the user's actual trade decisions (not anything this
 * tool decides on its own) so that, over time, win-rate / R-multiple / average
 * outcome can be measured against the market context that was present at
 * entry (option levels, IV skew, RSI, S/R zones, etc.) — the point is to learn
 * which setups actually work, not just to log P&L.
 *
 * Storage: a single JSON file (not JSONL) since trades get updated on close,
 * not just appended.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const JOURNAL_FILE = join(DATA_DIR, 'trade_journal.json');

function load() {
  if (!existsSync(JOURNAL_FILE)) return [];
  return JSON.parse(readFileSync(JOURNAL_FILE, 'utf8'));
}

function save(trades) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(JOURNAL_FILE, JSON.stringify(trades, null, 2), 'utf8');
}

/**
 * @param {object} p
 * @param {'long'|'short'} p.direction
 * @param {number} p.entry_price
 * @param {number} p.stop_loss
 * @param {number} [p.take_profit]
 * @param {number} [p.risk_usd] - $ amount risked (lost if stop hit) — enables pnl_usd on close
 * @param {string} p.reasoning - free text: why this trade
 * @param {string[]} [p.tags] - e.g. ["gamma_wall_bounce", "cpi_reaction"]
 * @param {object} [p.context_at_entry] - whatever market context the caller gathered (spot, option levels, RSI, S/R, etc.)
 * @param {string} [p.symbol]
 * @param {'manual'|'demo-auto'} [p.source] - 'manual' (default) for trades the user actually reports taking; 'demo-auto' for the hourly-analysis task's unattended paper-trading simulation. Keep these separable in stats — they answer different questions (does the system have edge? vs. how did the user's actual trading do?).
 */
export function openTrade(p) {
  if (p.direction !== 'long' && p.direction !== 'short') throw new Error("direction must be 'long' or 'short'");
  if (typeof p.entry_price !== 'number' || typeof p.stop_loss !== 'number') throw new Error('entry_price and stop_loss are required numbers');
  const riskPerUnit = p.direction === 'long' ? p.entry_price - p.stop_loss : p.stop_loss - p.entry_price;
  if (riskPerUnit <= 0) throw new Error(`stop_loss is on the wrong side of entry_price for a ${p.direction} trade`);

  const trades = load();
  const trade = {
    id: `trade_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`,
    status: 'open',
    source: p.source || 'manual',
    opened_at: new Date().toISOString(),
    closed_at: null,
    symbol: p.symbol || 'BTCUSD',
    direction: p.direction,
    entry_price: p.entry_price,
    stop_loss: p.stop_loss,
    take_profit: p.take_profit ?? null,
    risk_per_unit: riskPerUnit,
    risk_usd: p.risk_usd ?? null,
    reasoning: p.reasoning || '',
    tags: p.tags || [],
    context_at_entry: p.context_at_entry || {},
    exit: null,
    pnl_usd: null,
    pnl_pct: null,
    r_multiple: null,
  };
  trades.push(trade);
  save(trades);
  return trade;
}

/**
 * Checks all open trades against a fresh price and auto-closes any whose
 * stop_loss or take_profit has been crossed since entry — this is what lets
 * an unattended hourly task run a paper-trading simulation without a human
 * ever saying "I closed this". Closes at the level that was hit (not at
 * currentPrice) since that's the realistic fill for a resting stop/limit
 * order, not wherever price happens to be when this check runs.
 * @param {number} currentPrice
 * @returns {object[]} the trades that were closed by this call
 */
export function checkAndCloseHitTrades(currentPrice) {
  const trades = load();
  const closedNow = [];
  for (const trade of trades) {
    if (trade.status !== 'open') continue;
    let hitPrice = null, reason = null;
    if (trade.direction === 'long') {
      if (currentPrice <= trade.stop_loss) { hitPrice = trade.stop_loss; reason = 'stop'; }
      else if (trade.take_profit != null && currentPrice >= trade.take_profit) { hitPrice = trade.take_profit; reason = 'target'; }
    } else {
      if (currentPrice >= trade.stop_loss) { hitPrice = trade.stop_loss; reason = 'stop'; }
      else if (trade.take_profit != null && currentPrice <= trade.take_profit) { hitPrice = trade.take_profit; reason = 'target'; }
    }
    if (hitPrice != null) {
      const priceDelta = trade.direction === 'long' ? hitPrice - trade.entry_price : trade.entry_price - hitPrice;
      const rMultiple = priceDelta / trade.risk_per_unit;
      trade.status = 'closed';
      trade.closed_at = new Date().toISOString();
      trade.exit = { price: hitPrice, reason, notes: `auto-closed: price reached ${currentPrice}` };
      trade.r_multiple = rMultiple;
      trade.pnl_pct = (priceDelta / trade.entry_price) * 100;
      trade.pnl_usd = trade.risk_usd != null ? rMultiple * trade.risk_usd : null;
      closedNow.push(trade);
    }
  }
  if (closedNow.length) save(trades);
  return closedNow;
}

/**
 * @param {string} id
 * @param {object} p
 * @param {number} p.exit_price
 * @param {'stop'|'target'|'manual'|'other'} p.exit_reason
 * @param {string} [p.notes]
 */
export function closeTrade(id, p) {
  const trades = load();
  const trade = trades.find(t => t.id === id);
  if (!trade) throw new Error(`Trade not found: ${id}`);
  if (trade.status === 'closed') throw new Error(`Trade already closed: ${id}`);
  if (typeof p.exit_price !== 'number') throw new Error('exit_price is a required number');

  const priceDelta = trade.direction === 'long' ? p.exit_price - trade.entry_price : trade.entry_price - p.exit_price;
  const rMultiple = priceDelta / trade.risk_per_unit;
  const pnlPct = (priceDelta / trade.entry_price) * 100;
  const pnlUsd = trade.risk_usd != null ? rMultiple * trade.risk_usd : null;

  trade.status = 'closed';
  trade.closed_at = new Date().toISOString();
  trade.exit = { price: p.exit_price, reason: p.exit_reason || 'manual', notes: p.notes || '' };
  trade.r_multiple = rMultiple;
  trade.pnl_pct = pnlPct;
  trade.pnl_usd = pnlUsd;

  save(trades);
  return trade;
}

export function listTrades(status) {
  const trades = load();
  return status ? trades.filter(t => t.status === status) : trades;
}

export function getStats(tagFilter, sourceFilter) {
  let closed = load().filter(t => t.status === 'closed');
  if (tagFilter) closed = closed.filter(t => t.tags.includes(tagFilter));
  if (sourceFilter) closed = closed.filter(t => t.source === sourceFilter);
  if (!closed.length) return { count: 0 };

  const wins = closed.filter(t => t.r_multiple > 0);
  const losses = closed.filter(t => t.r_multiple <= 0);
  const avg = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;

  return {
    count: closed.length,
    wins: wins.length,
    losses: losses.length,
    win_rate_pct: (wins.length / closed.length) * 100,
    avg_r_multiple: avg(closed.map(t => t.r_multiple)),
    avg_win_r: avg(wins.map(t => t.r_multiple)),
    avg_loss_r: avg(losses.map(t => t.r_multiple)),
    total_pnl_usd: closed.some(t => t.pnl_usd != null) ? closed.reduce((s, t) => s + (t.pnl_usd || 0), 0) : null,
    expectancy_r: avg(closed.map(t => t.r_multiple)), // same as avg_r_multiple, named for clarity
  };
}

/** Break down stats by each tag seen across closed trades — surfaces which setup types actually work. */
export function getStatsByTag(sourceFilter) {
  let closed = load().filter(t => t.status === 'closed');
  if (sourceFilter) closed = closed.filter(t => t.source === sourceFilter);
  const tags = new Set(closed.flatMap(t => t.tags));
  const out = {};
  for (const tag of tags) out[tag] = getStats(tag, sourceFilter);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  if (cmd === 'stats') {
    const source = process.argv[3]; // optional: 'manual' | 'demo-auto'
    console.log(JSON.stringify({ overall: getStats(undefined, source), by_tag: getStatsByTag(source) }, null, 2));
  } else if (cmd === 'list') {
    console.log(JSON.stringify(listTrades(process.argv[3]), null, 2));
  } else if (cmd === 'open') {
    const payload = JSON.parse(process.argv[3]);
    console.log(JSON.stringify(openTrade(payload), null, 2));
  } else if (cmd === 'open-file') {
    const payload = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    console.log(JSON.stringify(openTrade(payload), null, 2));
  } else if (cmd === 'close') {
    const [, , , id, priceStr, reason] = process.argv;
    console.log(JSON.stringify(closeTrade(id, { exit_price: +priceStr, exit_reason: reason || 'manual' }), null, 2));
  } else if (cmd === 'check-exits') {
    const price = +process.argv[3];
    if (!Number.isFinite(price)) throw new Error('check-exits requires a numeric current price');
    console.log(JSON.stringify(checkAndCloseHitTrades(price), null, 2));
  } else {
    console.log('Usage: node trade_journal.mjs stats | list [open|closed] | open \'<json>\' | open-file <path> | close <id> <price> [reason] | check-exits <price>');
  }
}
