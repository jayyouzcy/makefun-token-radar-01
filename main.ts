// Token Radar — a token-launch radar for protocols that record no token yet.
//
// Reads the sealed DefiLlama snapshot (protocols, watchlist, floor), scores every
// protocol that records no token, and writes a ranked board plus a static,
// no-network dashboard. Run it with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
//
// Value model (see scoreProtocol): implied value starts from TVL and is moved by
// the protocol's own figures only — 7-day TVL growth, how long it has run with no
// token, how many chains it runs on, and its category. No list of names anywhere:
// the same code ranks any snapshot. A protocol "records no token" when DefiLlama
// carries no gecko_id and no symbol for it; that is a record, never proof it has
// no token, and the dashboard says so on every row. Centralised venues and
// wrapped / staked / bridged products of a token that already trades are left
// off the board: no token of their own is coming, so ranking them would be noise.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const BOARD_SIZE = 200;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

function loadSnapshot(path: string): Snapshot {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist) || typeof raw.as_of !== 'string') {
    throw new Error('snapshot: expected {as_of, protocols[], watchlist[]}');
  }
  return raw;
}

/** Whole days between two UTC dates (listed_at is a YYYY-MM-DD day). */
function daysBetween(fromDay: string, toDay: string): number {
  const ms = Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`);
  return Math.max(0, Math.floor(ms / 86_400_000));
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Value model — every factor comes from the snapshot row itself.
// ---------------------------------------------------------------------------

/** 7-day TVL growth moves value by at most -15% / +50%: momentum, not hype. */
function growthFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  return 1 + clamp(change7d, -30, 100) / 100 * 0.5;
}

/** Days listed with no token: the longer the record, the more "overdue" the launch. */
function ageFactor(listedAt: string | null, asOf: string): number {
  if (!listedAt) return 1.1; // unlisted age is unknown; give the middle of the range.
  const days = daysBetween(listedAt, asOf.slice(0, 10));
  return 1 + 0.35 * Math.min(days, 1500) / 1500;
}

/** More chains = more surface for a token to capture; log-damped so 85 chains != 85x. */
function chainFactor(chains: string[]): number {
  return 1 + 0.08 * Math.log1p(chains.length);
}

/**
 * Category shapes how much of TVL a token could plausibly capture. Centralised
 * venues and bridges rarely issue a token their users need, so they are
 * discounted; on-chain money markets and exchanges keep the full multiple.
 */
function categoryFactor(category: string | null): number {
  const c = (category ?? '').toLowerCase();
  if (c.includes('cex')) return 0.7;
  if (c.includes('bridge')) return 0.8;
  if (c.includes('liquid staking') || c.includes('restak')) return 0.85;
  if (c.includes('lending') || c.includes('cdp') || c.includes('dex') || c.includes('derivative')) return 1.1;
  if (c.includes('yield') || c.includes('farm')) return 1.05;
  return 1;
}

interface Scored extends Proto {
  implied: number;
  factors: { growth: number; age: number; chains: number; category: number; multiple: number };
  ageDays: number | null;
  onWatchlist: boolean;
}

/** Implied value = TVL x a 0.42 base multiple, moved by the four factors above. */
function scoreProtocol(p: Proto, asOf: string, onWatchlist: boolean): Scored {
  const growth = growthFactor(p.change_7d);
  const age = ageFactor(p.listed_at, asOf);
  const chains = chainFactor(p.chains);
  const category = categoryFactor(p.category);
  const multiple = 0.42 * growth * age * chains * category;
  return {
    ...p,
    implied: Math.max(1, Math.round(p.tvl_usd * multiple)),
    factors: {
      growth: round2(growth),
      age: round2(age),
      chains: round2(chains),
      category: round2(category),
      multiple: round2(multiple),
    },
    ageDays: p.listed_at ? daysBetween(p.listed_at, asOf.slice(0, 10)) : null,
    onWatchlist,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Farm plans — concrete steps built from the protocol's own category/chains.
// ---------------------------------------------------------------------------

function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

function groupOf(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lending') || c.includes('cdp')) return 'lending';
  if (c.includes('dex') || c.includes('derivative')) return 'dex';
  if (c.includes('stak') || c.includes('restak')) return 'staking';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('yield') || c.includes('farm') || c.includes('vault')) return 'yield';
  if (c.includes('rwa')) return 'rwa';
  return 'general';
}

/** The protocol's main on-chain action, phrased for its category. */
function coreAction(p: Scored): string {
  const chain = p.chains[0] ?? 'its main chain';
  const name = p.name;
  switch (groupOf(p.category)) {
    case 'lending':
      return `Supply ${money(200)}–${money(1000)} of USDC or ETH as collateral on ${name} (${chain}), then borrow 30–40% of it in a stablecoin so the position stays healthy; keep the health factor above 2.0 and top it up if it slips.`;
    case 'dex':
      return `Swap ${money(100)}–${money(500)} through ${name} on ${chain} in 3 separate trades, then add ${money(200)}–${money(500)} to a high-volume pair pool and leave the liquidity in for at least 4 weeks to collect fees.`;
    case 'staking':
      return `Stake ${money(200)}–${money(1000)} of the native asset through ${name} on ${chain} and keep the receipt token in your wallet; do not unstake for at least 30 days, and restake any rewards once a week.`;
    case 'bridge':
      return `Bridge ${money(100)}–${money(300)} of USDC through ${name} to ${chain} in 2 transfers on different days, then use the bridged funds on the destination chain instead of bridging them straight back.`;
    case 'yield':
      return `Deposit ${money(200)}–${money(800)} into the highest-TVL vault on ${name} (${chain}), claim or compound the yield once a week, and keep the deposit in for 6–8 weeks rather than hopping in and out.`;
    case 'rwa':
      return `Buy ${money(200)}–${money(500)} of a tokenised asset on ${name} (${chain}), hold it for at least 30 days, and reinvest any yield it pays instead of withdrawing it immediately.`;
    default:
      return `Use ${name}'s main product on ${chain} with ${money(100)}–${money(500)}: complete one real transaction a week for 6–8 weeks (about 10–20 minutes each), and keep a small balance in the protocol between visits.`;
  }
}

function farmSteps(p: Scored): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const extra = p.chains[1];
  const weekly = coreAction(p);
  const steps: string[] = [
    `Set up first: create a fresh wallet for farming, fund it with ${money(300)}–${money(1000)} of USDC plus ${money(20)} of the ${chain} gas token, and write down the seed phrase offline before you touch ${p.name}.`,
    weekly,
    extra
      ? `Go multi-chain: repeat the same action once on ${extra} with ${money(100)}–${money(300)} so your activity spans at least two of ${p.name}'s ${p.chains.length} chains; allow 30–45 minutes and about ${money(5)} in gas.`
      : `Go deeper: repeat the same action a second time with a different asset (for example ETH instead of USDC) and ${money(100)}–${money(300)}, keeping total exposure under ${money(1500)}; allow 20–30 minutes.`,
    `Stay consistent: repeat one real interaction every week for 6–8 weeks (roughly 15 minutes a week, ${money(1)}–${money(5)} in gas each time) instead of one big burst, because airdrop snapshots usually reward sustained use over a single day.`,
    `Track it: save every transaction hash in a note, check ${p.name}'s points or quests page once a week, and never pay anyone for a "guaranteed" allocation — if the protocol records a token later, eligibility is checked from your on-chain history alone.`,
  ];
  return steps;
}

// ---------------------------------------------------------------------------
// Board assembly
// ---------------------------------------------------------------------------

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

function buildBoard(snap: Snapshot): { rows: BoardRow[]; scored: Scored[] } {
  const watch = new Set(snap.watchlist);
  // Skip the products the watchlist rule itself leaves out: centralised venues
  // and wrapped / staked / bridged products of a token that already trades.
  // The watchlist never names one of these, so coverage is unaffected.
  const NOT_LAUNCH_CANDIDATES = new Set([
    'cex',
    'bridge',
    'canonical bridge',
    'cross chain bridge',
    'liquid staking',
    'liquid restaking',
    'restaked btc',
  ]);
  const preToken = snap.protocols.filter(
    (p) => p.gecko_id === null && p.symbol === null && !NOT_LAUNCH_CANDIDATES.has((p.category ?? '').toLowerCase()),
  );
  const scored = preToken.map((p) => scoreProtocol(p, snap.as_of, watch.has(p.slug)));
  scored.sort((a, b) => b.implied - a.implied || b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug));

  // Top 200 by score, with every watchlist protocol forced in.
  const picked: Scored[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (s.onWatchlist) {
      picked.push(s);
      seen.add(s.slug);
    }
  }
  for (const s of scored) {
    if (picked.length >= BOARD_SIZE) break;
    if (!seen.has(s.slug)) {
      picked.push(s);
      seen.add(s.slug);
    }
  }
  picked.sort((a, b) => b.implied - a.implied || b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug));

  // Enforce a strictly falling implied value down the ranks.
  let prev = Number.POSITIVE_INFINITY;
  const rows: BoardRow[] = picked.map((s, i) => {
    const implied = Math.min(s.implied, prev - 1);
    prev = implied;
    return { slug: s.slug, name: s.name, rank: i + 1, implied_value_usd: implied, farm_steps: farmSteps(s) };
  });
  // Keep the scored list in the same order, with the enforced values, for data.js.
  const ordered = picked.map((s, i) => ({ ...s, implied: rows[i]!.implied_value_usd }));
  return { rows, scored: ordered };
}

function boardProblem(rows: BoardRow[], snap: Snapshot): string | null {
  if (rows.length < 100) return `board holds ${rows.length} rows, fewer than 100`;
  const slugs = new Set(snap.protocols.map((p) => p.slug));
  for (const r of rows) if (!slugs.has(r.slug)) return `row ${r.slug} is not in the snapshot`;
  for (const s of snap.watchlist) if (!rows.some((r) => r.slug === s)) return `watchlist ${s} is missing`;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) return 'implied value rises down the ranks';
  }
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug}: ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim().length;
      if (t < 20 || t > 600) return `${r.slug}: a farm step is ${t} characters`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dashboard data (data.js) — the page reads this, no network involved.
// ---------------------------------------------------------------------------

function dataScript(snap: Snapshot, scored: Scored[]): string {
  const payload = {
    asOf: snap.as_of,
    source: snap.source,
    floorUsd: snap.floor_usd,
    watchlistSize: snap.watchlist.length,
    protocolCount: snap.protocols.length,
    rows: scored.map((s) => ({
      slug: s.slug,
      name: s.name,
      category: s.category,
      chains: s.chains,
      tvl: s.tvl_usd,
      change7d: s.change_7d,
      listedAt: s.listed_at,
      ageDays: s.ageDays,
      implied: s.implied,
      watchlist: s.onWatchlist,
      factors: s.factors,
    })),
    plans: Object.fromEntries(scored.map((s) => [s.slug, farmSteps(s)])),
  };
  return `window.TOKEN_RADAR = ${JSON.stringify(payload)};\n`;
}

// ---------------------------------------------------------------------------
// CLI / file output
// ---------------------------------------------------------------------------

function argValue(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const out: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    out.push(name);
  }
  return out;
}

const inputArg = argValue('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const outDir = argValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = loadSnapshot(inputFile);
const { rows, scored } = buildBoard(snapshot);
const problem = boardProblem(rows, snapshot);
if (problem !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${problem}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(snapshot, scored));

copyDir(join(here, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyDir(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${rows.length} rows ranked\n` +
    `token radar: rank 1 ${rows[0]!.slug} at $${rows[0]!.implied_value_usd.toLocaleString('en-US')}, rank ${rows.length} ${rows[rows.length - 1]!.slug} at $${rows[rows.length - 1]!.implied_value_usd.toLocaleString('en-US')}\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')}, ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`,
);
