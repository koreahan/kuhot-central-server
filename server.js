const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const INGEST_KEY = String(process.env.KUHOT_INGEST_KEY || 'CHANGE_ME_LONG_RANDOM_KEY');
const READ_KEY = String(process.env.KUHOT_READ_KEY || '');
const DATABASE_URL = process.env.DATABASE_URL || '';
const RETENTION_DAYS = Number(process.env.KUHOT_RETENTION_DAYS || 7);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const hasDb = Boolean(DATABASE_URL);
const pool = hasDb
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    })
  : null;

const memSnaps = [];
let memId = 1;
let LAST_CLEANUP_MS = 0;

function nowMs() {
  return Date.now();
}

function toInt(v, fallback = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const s = String(v ?? '').replace(/[^0-9.-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function normSpace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function pct(base, price) {
  if (!base || !price) return null;
  return Math.round(((price - base) * 1000) / base) / 10;
}

function optionKeyFromText(text) {
  let raw = normSpace(text).toLowerCase();
  raw = raw.replace(/×/g, 'x');
  raw = raw.replace(/\([^)]*(?:당|원)[^)]*\)/g, ' ');
  raw = raw.replace(/\d{1,3}(?:,\d{3})+\s*원|\d{4,}\s*원/g, ' ');
  raw = raw.replace(/(?:무료배송|로켓배송|로켓프레시|와우|쿠폰|카드|할인|최종|혜택가|상세보기|구매하기)/g, ' ');
  raw = raw.replace(/(\d+(?:\.\d+)?)\s*킬로그램/g, '$1kg');
  raw = raw.replace(/(\d+(?:\.\d+)?)\s*키로/g, '$1kg');
  raw = raw.replace(/(\d+(?:\.\d+)?)\s*그램/g, '$1g');
  raw = raw.replace(/(\d+(?:\.\d+)?)\s*리터/g, '$1l');
  raw = raw.replace(/(\d+(?:\.\d+)?)\s*밀리리터/g, '$1ml');

  const unit = '(?:kg|g|mg|ml|l|개입|개|입|통|팩|봉|병|캔|매|롤|세트|박스|포|정|장|p|pack|ea)';
  const tokens = [];
  const re = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(' + unit + ')', 'gi');
  let m;
  while ((m = re.exec(raw))) {
  tokens.push(String(m[1]) + String(m[2]).toLowerCase());
}

  const mul = new RegExp('(\\d+)\\s*x\\s*(\\d+)\\s*(' + unit + ')', 'gi');
  while ((m = mul.exec(raw))) {
  tokens.push(String(m[1]) + 'x' + String(m[2]) + String(m[3]).toLowerCase());
}

  return [...new Set(tokens)].sort().join('|') || 'default';
}

function classifyCategory(title) {
  const t = String(title || '').toLowerCase();
  if (/라면|식품|쌀|쿠키|과자|음료|커피|고기|계란|우유|치즈|김치|냉동|즉석|과일|소스|오뚜기|풀무원|삼양|샘표/.test(t)) return '식품';
  if (/세제|휴지|물티슈|샴푸|치약|칫솔|청소|주방|수건|욕실|생활/.test(t)) return '생활';
  if (/노트북|모니터|냉장고|세탁기|청소기|가전|충전기|마우스|키보드|이어폰|스피커|ssd|usb/.test(t)) return '가전';
  if (/화장품|크림|로션|선크림|뷰티|마스크팩|앰플|토너/.test(t)) return '뷰티';
  if (/캠핑|텐트|침낭|랜턴|아이스박스|타프|의자/.test(t)) return '캠핑';
  if (/강아지|고양이|반려|사료|간식|배변|모래/.test(t)) return '반려';
  return '기타';
}

function bigNeedPct(price) {
  if (price <= 5000) return 50;
  if (price <= 10000) return 45;
  return 35;
}

function extractProductId(url) {
  const m = String(url || '').match(/\/vp\/products\/(\d+)/i);
  return m ? m[1] : '';
}

function normalizeSnap(raw) {
  const title = normSpace(raw.title || raw.name || raw.productName || '');
  const url = normSpace(raw.url || raw.href || '');
  const productId = normSpace(raw.productId || raw.pid || extractProductId(url));
  const vendorItemId = normSpace(raw.vendorItemId || raw.vid || '');
  const price = toInt(raw.payPrice ?? raw.finalPrice ?? raw.price ?? raw.shownPrice ?? raw.wowPrice);
  const wowPrice = toInt(raw.wowPrice ?? raw.shownPrice ?? raw.basePrice ?? raw.price ?? price);
  const couponOff = toInt(raw.couponOff ?? raw.coupon ?? raw.couponDiscount);
  const cardOff = toInt(raw.cardBestOff ?? raw.cardOff ?? raw.cardDiscount);
  const cardText = normSpace(raw.cardText || raw.cardBestInfo || raw.cardInfo || '');
  const optionKey = normSpace(raw.optionKey || optionKeyFromText(`${title} ${url}`));
  const category = normSpace(raw.category || classifyCategory(title));
  const tsMs = toInt(raw.tsMs || raw.tsUtc || raw.timestamp, nowMs());

  return {
    title,
    url,
    productId,
    vendorItemId,
    price,
    wowPrice,
    couponOff,
    cardOff,
    cardText,
    optionKey,
    category,
    tsMs
  };
}

function cleanHistory(prices) {
  let vals = prices.map(v => toInt(v)).filter(v => v >= 500).sort((a, b) => a - b);
  if (vals.length >= 5) {
    const med = vals[Math.floor(vals.length / 2)];
    if (med >= 3000) {
      const lo = Math.max(500, Math.floor(med * 0.3));
      const hi = Math.floor(med * 2.0);
      const filtered = vals.filter(v => v >= lo && v <= hi);
      if (filtered.length >= 3) vals = filtered;
    }
  }
  return vals;
}

function meanExOneMin(vals) {
  const a = cleanHistory(vals);
  if (a.length <= 1) return 0;
  const b = a.slice();
  b.splice(b.indexOf(Math.min(...b)), 1);
  if (!b.length) return 0;
  return Math.round(b.reduce((x, y) => x + y, 0) / b.length);
}

async function cleanupDuplicateSnapshots() {
  if (!hasDb) return { db: 'memory', deleted: 0 };

  const r = await pool.query(`
    DELETE FROM snapshots a
    USING snapshots b
    WHERE a.id < b.id
      AND a.product_id = b.product_id
      AND a.option_key = b.option_key
      AND a.ts_ms = b.ts_ms
  `);

  return { db: 'postgres', deleted: r.rowCount || 0 };
}

async function cleanupOldSnapshots(days = RETENTION_DAYS) {
  const keepDays = Math.max(1, Math.min(365, Number(days || 7)));
  const cutoff = nowMs() - keepDays * 24 * 60 * 60 * 1000;

  if (!hasDb) {
    const before = memSnaps.length;
    for (let i = memSnaps.length - 1; i >= 0; i--) {
      if (Number(memSnaps[i].ts_ms || 0) < cutoff) {
        memSnaps.splice(i, 1);
      }
    }
    return { db: 'memory', days: keepDays, cutoff, deleted: before - memSnaps.length };
  }

  const r = await pool.query(
    `DELETE FROM snapshots WHERE ts_ms < $1`,
    [cutoff]
  );

  return { db: 'postgres', days: keepDays, cutoff, deleted: r.rowCount || 0 };
}

async function maybeCleanupOldSnapshots() {
  const intervalMs = 60 * 60 * 1000;
  if (Date.now() - LAST_CLEANUP_MS < intervalMs) return null;

  LAST_CLEANUP_MS = Date.now();

  try {
    const result = await cleanupOldSnapshots(RETENTION_DAYS);
    console.log('[cleanupOldSnapshots]', result);
    return result;
  } catch (e) {
    console.error('[cleanupOldSnapshots failed]', e);
    return null;
  }
}

async function initDb() {
  if (!hasDb) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id BIGSERIAL PRIMARY KEY,
      product_id TEXT NOT NULL,
      option_key TEXT NOT NULL,
      vendor_item_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      url TEXT DEFAULT '',
      category TEXT DEFAULT '기타',
      price INTEGER NOT NULL,
      wow_price INTEGER DEFAULT 0,
      coupon_off INTEGER DEFAULT 0,
      card_off INTEGER DEFAULT 0,
      card_text TEXT DEFAULT '',
      avg_price INTEGER DEFAULT 0,
      low_price INTEGER DEFAULT 0,
      avg_pct REAL,
      low_pct REAL,
      is_feed BOOLEAN DEFAULT FALSE,
      is_hot BOOLEAN DEFAULT FALSE,
      is_big BOOLEAN DEFAULT FALSE,
      is_new_low BOOLEAN DEFAULT FALSE,
      ts_ms BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_snap_product_option_ts
      ON snapshots(product_id, option_key, ts_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_snap_deal_ts
      ON snapshots(is_feed, ts_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_snap_category_ts
      ON snapshots(category, ts_ms DESC);
  `);

  await cleanupDuplicateSnapshots();

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_snap_product_option_ts
      ON snapshots(product_id, option_key, ts_ms);
  `);
}

async function historyPricesDb(productId, optionKey, beforeTsMs) {
  if (!hasDb) {
    return memSnaps
      .filter(s => s.product_id === productId && s.option_key === optionKey && s.ts_ms < beforeTsMs)
      .sort((a, b) => b.ts_ms - a.ts_ms)
      .slice(0, 60)
      .map(s => s.price);
  }

  const r = await pool.query(
    `SELECT price
     FROM snapshots
     WHERE product_id=$1 AND option_key=$2 AND ts_ms<$3 AND price>0
     ORDER BY ts_ms DESC
     LIMIT 60`,
    [productId, optionKey, beforeTsMs]
  );
  return r.rows.map(x => Number(x.price));
}

async function processOne(raw) {
  const s = normalizeSnap(raw);
  if (!s.productId || !s.title || !s.price || s.price < 500) {
    return { ok: false, skipped: true, reason: 'bad snap' };
  }

  const hist = await historyPricesDb(s.productId, s.optionKey, s.tsMs);
  const basis = cleanHistory(hist);
  const lowPrice = basis.length ? Math.min(...basis) : 0;
  const avgPrice = meanExOneMin(basis);
  const avgPct = avgPrice ? pct(avgPrice, s.price) : null;
  const lowPct = lowPrice ? pct(lowPrice, s.price) : null;
  const isFeed = avgPct !== null && avgPct <= -15;
  const isHot = avgPct !== null && avgPct <= -20;
  const isBig = avgPct !== null && avgPct <= -bigNeedPct(s.price);
  const isNewLow = Boolean(lowPrice && s.price < lowPrice);

  const row = {
    product_id: s.productId,
    option_key: s.optionKey,
    vendor_item_id: s.vendorItemId,
    title: s.title,
    url: s.url,
    category: s.category,
    price: s.price,
    wow_price: s.wowPrice,
    coupon_off: s.couponOff,
    card_off: s.cardOff,
    card_text: s.cardText,
    avg_price: avgPrice,
    low_price: lowPrice,
    avg_pct: avgPct,
    low_pct: lowPct,
    is_feed: isFeed,
    is_hot: isHot,
    is_big: isBig,
    is_new_low: isNewLow,
    ts_ms: s.tsMs
  };

  if (!hasDb) {
    const duplicate = memSnaps.some(x =>
      x.product_id === row.product_id &&
      x.option_key === row.option_key &&
      Number(x.ts_ms || 0) === Number(row.ts_ms || 0)
    );

    if (duplicate) return { ok: true, duplicate: true, deal: false, row };

    row.id = memId++;
    memSnaps.push(row);
    await cleanupOldSnapshots(RETENTION_DAYS);
    if (memSnaps.length > 20000) memSnaps.splice(0, memSnaps.length - 20000);
    return { ok: true, inserted: true, deal: isFeed, row };
  }

  const inserted = await pool.query(
    `INSERT INTO snapshots(product_id, option_key, vendor_item_id, title, url, category, price, wow_price, coupon_off, card_off, card_text, avg_price, low_price, avg_pct, low_pct, is_feed, is_hot, is_big, is_new_low, ts_ms)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (product_id, option_key, ts_ms) DO NOTHING
     RETURNING id`,
    [
      row.product_id,
      row.option_key,
      row.vendor_item_id,
      row.title,
      row.url,
      row.category,
      row.price,
      row.wow_price,
      row.coupon_off,
      row.card_off,
      row.card_text,
      row.avg_price,
      row.low_price,
      row.avg_pct,
      row.low_pct,
      row.is_feed,
      row.is_hot,
      row.is_big,
      row.is_new_low,
      row.ts_ms
    ]
  );

  const actuallyInserted = inserted.rowCount > 0;
  return { ok: true, inserted: actuallyInserted, duplicate: !actuallyInserted, deal: actuallyInserted && isFeed, row };
}

function requireIngest(req, res, next) {
  const key = String(req.header('x-kuhot-key') || req.query.key || '');
  if (!INGEST_KEY || INGEST_KEY === 'CHANGE_ME_LONG_RANDOM_KEY') {
    return res.status(500).json({ ok: false, error: 'KUHOT_INGEST_KEY is not configured' });
  }
  if (key !== INGEST_KEY) return res.status(401).json({ ok: false, error: 'BAD_INGEST_KEY' });
  next();
}

function requireRead(req, res, next) {
  if (!READ_KEY) return next();
  const key = String(req.header('x-kuhot-read-key') || req.query.readKey || '');
  if (key !== READ_KEY) return res.status(401).json({ ok: false, error: 'BAD_READ_KEY' });
  next();
}

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    service: 'KUHOT_CENTRAL_API',
    version: 'central-v2-retention-dedupe',
    db: hasDb ? 'postgres' : 'memory',
    retentionDays: RETENTION_DAYS,
    time: nowMs()
  });
});

app.post('/admin/cleanup', requireIngest, async (req, res) => {
  try {
    const days = Number(req.query.days || req.body?.days || RETENTION_DAYS || 7);
    const cleanup = await cleanupOldSnapshots(days);
    const dedupe = await cleanupDuplicateSnapshots();
    res.json({ ok: true, cleanup, dedupe });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/ingest/snaps', requireIngest, async (req, res) => {
  try {
    await maybeCleanupOldSnapshots();

    const arr = Array.isArray(req.body?.items) ? req.body.items : Array.isArray(req.body) ? req.body : [req.body];
    const results = [];
    for (const item of arr.slice(0, 500)) results.push(await processOne(item));
    const saved = results.filter(r => r.ok && r.inserted).length;
    const duplicates = results.filter(r => r.ok && r.duplicate).length;
    const deals = results.filter(r => r.ok && r.deal).length;
    res.json({ ok: true, saved, duplicates, deals });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

function buildDealsFromRows(rows, filter, category, limit) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.product_id || !r.option_key || !r.price) continue;
    const k = `${r.product_id}::${r.option_key}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const out = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => Number(a.ts_ms || 0) - Number(b.ts_ms || 0));
    const latest = arr[arr.length - 1];
    const hist = arr.slice(0, -1).map(x => Number(x.price || 0)).filter(v => v > 0);
    if (!hist.length) continue;

    const basis = cleanHistory(hist);
    if (!basis.length) continue;

    const lowPrice = Math.min(...basis);
    const avgPrice = meanExOneMin(basis);
    const avgPct = avgPrice ? pct(avgPrice, latest.price) : null;
    const lowPct = lowPrice ? pct(lowPrice, latest.price) : null;
    const isFeed = avgPct !== null && avgPct <= -15;
    const isHot = avgPct !== null && avgPct <= -20;
    const isBig = avgPct !== null && avgPct <= -bigNeedPct(Number(latest.price || 0));
    const isNewLow = Boolean(lowPrice && Number(latest.price || 0) < lowPrice);

    if (!isFeed) continue;
    if (filter === 'hot' && !isHot) continue;
    if (filter === 'big' && !isBig) continue;
    if (filter === 'new_low' && !isNewLow) continue;
    if (category && category !== '전체' && latest.category !== category) continue;

    out.push({
      ...latest,
      avg_price: avgPrice,
      low_price: lowPrice,
      avg_pct: avgPct,
      low_pct: lowPct,
      is_feed: isFeed,
      is_hot: isHot,
      is_big: isBig,
      is_new_low: isNewLow
    });
  }

  return out.sort((a, b) => {
    const ap = Number(a.avg_pct ?? 999);
    const bp = Number(b.avg_pct ?? 999);
    if (ap !== bp) return ap - bp;
    return Number(b.ts_ms || 0) - Number(a.ts_ms || 0);
  }).slice(0, limit);
}

app.get('/stats', requireRead, async (req, res) => {
  try {
    if (!hasDb) {
      const deals = buildDealsFromRows(memSnaps, 'all', '전체', 1000000);
      return res.json({
        ok: true,
        db: 'memory',
        retentionDays: RETENTION_DAYS,
        snapshots: memSnaps.length,
        deals: deals.length,
        groups: new Set(memSnaps.map(r => `${r.product_id}::${r.option_key}`)).size
      });
    }

    const total = await pool.query('SELECT COUNT(*)::int AS c FROM snapshots');
    const groups = await pool.query('SELECT COUNT(*)::int AS c FROM (SELECT DISTINCT product_id, option_key FROM snapshots) x');
    const size = await pool.query(`
      SELECT
        pg_total_relation_size('snapshots')::bigint AS bytes,
        pg_size_pretty(pg_total_relation_size('snapshots')) AS pretty
    `);
    const sample = await pool.query('SELECT * FROM snapshots ORDER BY ts_ms DESC LIMIT 20000');
    const deals = buildDealsFromRows(sample.rows, 'all', '전체', 1000000);

    res.json({
      ok: true,
      db: 'postgres',
      retentionDays: RETENTION_DAYS,
      snapshots: total.rows[0].c,
      groups: groups.rows[0].c,
      deals_sample: deals.length,
      snapshots_size_bytes: Number(size.rows[0].bytes || 0),
      snapshots_size: size.rows[0].pretty
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/deals', requireRead, async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all');
    const category = String(req.query.category || '전체');
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 60)));

    if (!hasDb) {
      return res.json({ ok: true, items: buildDealsFromRows(memSnaps, filter, category, limit) });
    }

    const r = await pool.query(
      `SELECT * FROM snapshots
       WHERE price > 0
       ORDER BY ts_ms DESC
       LIMIT 50000`
    );
    res.json({ ok: true, items: buildDealsFromRows(r.rows, filter, category, limit) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/history/:productId', requireRead, async (req, res) => {
  try {
    const productId = String(req.params.productId || '');
    const optionKey = String(req.query.optionKey || '');
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 80)));

    if (!hasDb) {
      const items = memSnaps
        .filter(r => r.product_id === productId && (!optionKey || r.option_key === optionKey))
        .sort((a, b) => b.ts_ms - a.ts_ms)
        .slice(0, limit);
      return res.json({ ok: true, items });
    }

    const r = await pool.query(
      `SELECT * FROM snapshots
       WHERE product_id=$1 AND ($2='' OR option_key=$2)
       ORDER BY ts_ms DESC
       LIMIT $3`,
      [productId, optionKey, limit]
    );
    res.json({ ok: true, items: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

initDb().then(async () => {
  await cleanupOldSnapshots(RETENTION_DAYS).catch((e) => {
    console.error('[startup cleanup failed]', e);
  });

  app.listen(PORT, () => {
    console.log(`[kuhot-central] listening on ${PORT} db=${hasDb ? 'postgres' : 'memory'} retentionDays=${RETENTION_DAYS}`);
  });
}).catch((e) => {
  console.error('[kuhot-central] failed to start', e);
  process.exit(1);
```js
});
