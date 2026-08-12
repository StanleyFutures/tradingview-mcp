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

export function getStats(tagFilter) {
  let closed = load().filter(t => t.status === 'closed');
  if (tagFilter) closed = closed.filter(t => t.tags.includes(tagFilter));
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
export function getStatsByTag() {
  const closed = load().filter(t => t.status === 'closed');
  const tags = new Set(closed.flatMap(t => t.tags));
  const out = {};
  for (const tag of tags) out[tag] = getStats(tag);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  if (cmd === 'stats') {
    console.log(JSON.stringify({ overall: getStats(), by_tag: getStatsByTag() }, null, 2));
  } else if (cmd === 'list') {
    console.log(JSON.stringify(listTrades(process.argv[3]), null, 2));
  } else {
    console.log('Usage: node trade_journal.mjs stats | list [open|closed]');
  }
}
