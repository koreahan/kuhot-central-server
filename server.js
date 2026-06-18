
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import pg from 'pg';
import { Expo } from 'expo-server-sdk';

const { Pool } = pg;
const app = express();
const expo = new Expo();

const PORT = Number(process.env.PORT || 8787);
const DATABASE_URL = process.env.DATABASE_URL || '';
const INGEST_KEY = process.env.INGEST_KEY || '';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

let pool = null;
const memory = { devices: new Map(), alerts: [], opens: [] };

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });
}

function now() { return Date.now(); }
function id(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }
function s(v, max = 500) { return String(v ?? '').trim().slice(0, max); }
function n(v) { const x = Number(v || 0); return Number.isFinite(x) ? Math.round(x) : 0; }
function f(v) { const x = Number(v || 0); return Number.isFinite(x) ? x : 0; }

function dedupeKey(a) {
  const product = s(a.productId || a.itemId || a.vendorItemId, 80);
  const opt = s(a.option || a.optionKey || '', 200).toLowerCase().replace(/\s+/g, ' ');
  const price = n(a.price || a.payPrice);
  if (product) return `PID:${product}:OPT:${opt}:PRICE:${price}`;
  return crypto.createHash('sha1').update(`${s(a.title).toLowerCase()}|${opt}|${price}`).digest('hex');
}

function normalizeAlert(body) {
  const price = n(body.price || body.payPrice);
  const avg = n(body.avg || body.avgPrice || body.baselineAvg);
  const title = cleanTitleText(body.title);
  const option = cleanOptionText(body.option || body.optionKey);
  const dropPct = f(body.dropPct || body.avgDrop || (avg > 0 && price > 0 ? ((avg - price) / avg) * 100 : 0));
  return {
    id: s(body.id) || id('alert'),
    dedupeKey: s(body.dedupeKey) || dedupeKey({ ...body, title, option, price }),
    source: s(body.source || 'unknown', 80),
    section: s(body.section || '핫딜', 80),
    title,
    option,
    price,
    avg,
    low: n(body.low || body.lowPrice || body.baselineLow),
    dropPct,
    appDiscount: f(body.appDiscount || body.discount),
    cardText: cleanCardText(body.cardText || body.cardBestInfo, title, option),
    // 구매 링크는 파트너스/제휴 링크를 최우선으로 저장합니다.
    url: s(body.partnerUrl || body.coupangPartnerUrl || body.affiliateUrl || body.shortUrl || body.deepLink || body.url || body.productUrl, 1000),
    originalUrl: s(body.originalUrl || body.productUrl || body.url, 1000),
    productId: s(body.productId, 80),
    itemId: s(body.itemId, 80),
    vendorItemId: s(body.vendorItemId, 80),
    createdAt: n(body.createdAt) || now(),
    raw: body
  };
}

function won(v) { return `${n(v).toLocaleString('ko-KR')}원`; }

function stripDealPrefix(text) {
  let t = s(text, 500);
  for (let i = 0; i < 4; i += 1) {
    const before = t;
    t = t
      .replace(/^✨\s*/u, '')
      .replace(/^(?:🔥\s*){1,3}대박(?:딜|알림)?\s*[:：\-·|]*/u, '')
      .replace(/^🔥🔥대박(?:딜|알림)?\s*[:：\-·|]*/u, '')
      .replace(/^대박(?:딜|알림)?\s*[:：\-·|]*/u, '')
      .replace(/^실시간\s*핫딜\s*[:：\-·|]*/u, '')
      .replace(/^인기\s*[:：\-·|]*/u, '')
      .trim();
    if (t === before) break;
  }
  return t;
}

function cleanTitleText(text) {
  let t = stripDealPrefix(text);
  // 상품명 끝에 붙는 가격 꼬리 제거.
  // 예: "도브 바디워시 (7,450원)", "도브 바디워시 (7,450?)"
  // 단순 용량(500g, 1kg)은 건드리지 않도록 콤마가 있는 금액 또는 "원" 포함 금액만 제거한다.
  t = t
    .replace(/\s*[（(]\s*\d{1,3}(?:,\d{3})+(?:\s*원|[^\d)]*)?\s*[）)]\s*$/u, '')
    .replace(/\s*\d{1,3}(?:,\d{3})+\s*원\s*$/u, '')
    .replace(/\s*\d{4,}\s*원\s*$/u, '')
    .trim();
  return t || s(text, 300);
}

function normKey(text) {
  return String(text || '').toLowerCase().replace(/[^0-9a-z가-힣]+/gi, '');
}

function cleanOptionText(rawOption) {
  const raw = s(rawOption, 300);
  if (!raw) return '';
  const parts = raw
    .replace(/\s*[·|/]\s*/g, ', ')
    .split(/\s*,\s*/g)
    .map(x => x.trim())
    .filter(Boolean);

  const kept = [];
  const seen = new Set();
  for (const part of parts) {
    const key = normKey(part);
    if (!key || seen.has(key)) continue;

    const mult = part.split(/\s*[xX×*]\s*/).map(x => x.trim()).filter(Boolean);
    if (mult.length >= 2) {
      const existing = new Set(kept.map(normKey));
      if (mult.every(x => existing.has(normKey(x)))) continue;
    }

    seen.add(key);
    kept.push(part);
  }
  return kept.join(', ');
}

function cleanCardText(rawCard, title = '', option = '') {
  let t = s(rawCard, 220);
  if (!t) return '';
  t = t
    .replace(/^💳\s*/u, '')
    .replace(/^카드\s*할인\s*[:：]?\s*/u, '')
    .replace(/^카드가\s*[:：]?\s*/u, '')
    .trim();

  const key = normKey(t);
  const titleKey = normKey(title);
  const optionKey = normKey(option);
  if (!key) return '';
  if (titleKey && (key === titleKey || key.includes(titleKey.slice(0, Math.min(12, titleKey.length))))) return '';
  if (optionKey && (key === optionKey || key.includes(optionKey))) return '';

  const looksCard = /(카드|결제|즉시|할인|청구|신한|kb|국민|삼성|현대|롯데|하나|우리|bc|nh|농협|카카오|토스|씨티|기업|ibk)/i.test(t);
  if (!looksCard) return '';
  return t;
}

function splitCompactTitleOption(text) {
  const cleaned = cleanTitleText(text);
  const parts = cleaned.split(/\s+·\s+/u).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return { title: parts[0], option: parts.slice(1).join(' · ') };
  return { title: cleaned, option: '' };
}

function isCategoryOnlyLine(line) {
  return /^(?:🔥\s*){0,3}(?:대박|대박딜|대박\s*알림)$|^🔥🔥대박$|^실시간\s*핫딜$|^인기$/u.test(s(line).replace(/[:：\-·|]+$/u, '').trim());
}

function isBigText(text) {
  return /(?:🔥\s*){1,3}대박|대박딜|대박\s*알림/u.test(String(text || ''));
}

function isBigAlert(alert) {
  const section = s(alert.section || '', 120).replace(/\s+/g, '');
  const raw = alert.raw || {};
  const rawKind = s(raw.kind || raw.type || raw.level || alert.kind || alert.type || '', 80).toLowerCase();
  return (
    section.includes('대박') ||
    section.includes('긴급') ||
    rawKind.includes('대박') ||
    rawKind.includes('big') ||
    rawKind.includes('urgent') ||
    f(alert.dropPct) >= 30 ||
    f(alert.appDiscount) >= 30
  );
}

function pushMessage(a) {
  return `${a.title || '상품'} (${won(a.price)})`;
}

function pushTitle(a) {
  return isBigAlert(a) ? '🔥🔥대박' : '🔥인기';
}

function pushCompactText(a) {
  return `${pushTitle(a)}\n${pushMessage(a)}`;
}

function firstUrl(text) {
  const m = String(text || '').match(/https?:\/\/\S+/i);
  return m ? m[0].replace(/[)\]\s]+$/g, '') : '';
}

function firstWon(text) {
  const t = String(text || '');
  // 정상 한국어 문구: 7,450원
  let m = t.match(/([0-9][0-9,]*)\s*원/u);
  if (m) return n(m[1].replace(/,/g, ''));

  // PowerShell/콘솔 인코딩 문제로 "원"이 깨져도 괄호 안 금액은 잡는다.
  // 예: 도브 바디워시 (7,450?)
  m = t.match(/[（(]\s*([0-9][0-9,]*)\s*(?:원|[^\d)]*)?[）)]/u);
  if (m) return n(m[1].replace(/,/g, ''));

  // 최종 혜택가 : 7,450 처럼 원 글자가 빠진 경우의 마지막 방어.
  m = t.match(/(?:가격|혜택가|최종|핫딜|대박딜)[^0-9]*([0-9][0-9,]*)/u);
  return m ? n(m[1].replace(/,/g, '')) : 0;
}

function parseTelegramText(text, body = {}) {
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const titleLine = lines.find(x => x.startsWith('✨')) || lines.find(x => !x.startsWith('※') && !x.startsWith('└') && !x.startsWith('http') && !isCategoryOnlyLine(x)) || '';
  const optionLine = lines.find(x => x.startsWith('└')) || '';
  const priceLine = lines.find(x => x.includes('최종') || x.includes('혜택가') || x.includes('가격')) || lines.find(x => /[0-9][0-9,]*\s*원/u.test(x)) || lines.find(x => /[（(]\s*[0-9][0-9,]*/u.test(x)) || '';
  const avgLine = lines.find(x => x.includes('평균')) || '';
  const lowLine = lines.find(x => x.includes('최저')) || '';
  const url = s(body.partnerUrl || body.url || body.link || firstUrl(text), 1000);
  const price = n(body.price || firstWon(priceLine || titleLine));
  const compact = splitCompactTitleOption(body.title || titleLine);
  const title = cleanTitleText(compact.title || body.message || '텔레그램 핫딜');
  const option = s(body.option || optionLine.replace(/^└\s*/, '') || compact.option, 200);
  const section = s(body.section || (isBigText(text) ? '대박' : '인기'), 80);
  return normalizeAlert({
    source: body.source || 'telegram_bridge',
    section,
    title,
    option,
    price,
    avg: n(body.avg || firstWon(avgLine)),
    low: n(body.low || firstWon(lowLine)),
    dropPct: f(body.dropPct || body.avgDrop || 0),
    appDiscount: f(body.appDiscount || body.discount || 0),
    partnerUrl: url,
    url,
    originalUrl: body.originalUrl || body.productUrl || url,
    raw: { telegramText: text, ...body }
  });
}

async function sendTelegram(alert) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) return { sent: false, skipped: true };
  const text = `${pushCompactText(alert)}
${alert.url || ''}`.trim();
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false })
    });
    return { sent: r.ok, status: r.status };
  } catch (e) {
    return { sent: false, error: String(e.message || e) };
  }
}

async function initDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    device_name TEXT,
    platform TEXT,
    expo_push_token TEXT,
    settings JSONB DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT UNIQUE NOT NULL,
    source TEXT,
    section TEXT,
    title TEXT NOT NULL,
    option_text TEXT,
    price INTEGER NOT NULL,
    avg_price INTEGER DEFAULT 0,
    low_price INTEGER DEFAULT 0,
    drop_pct DOUBLE PRECISION DEFAULT 0,
    app_discount DOUBLE PRECISION DEFAULT 0,
    card_text TEXT,
    url TEXT,
    original_url TEXT,
    product_id TEXT,
    item_id TEXT,
    vendor_item_id TEXT,
    raw JSONB DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS alert_opens (
    id TEXT PRIMARY KEY,
    alert_id TEXT,
    device_id TEXT,
    url TEXT,
    opened_at BIGINT NOT NULL
  )`);
}

function allowIngest(req, res) {
  if (!INGEST_KEY) return true;
  const got = req.headers['x-ingest-key'] || req.body?.ingestKey || '';
  if (got === INGEST_KEY) return true;
  res.status(403).json({ ok: false, error: 'BAD_INGEST_KEY' });
  return false;
}

async function registerDevice(body) {
  const deviceId = s(body.deviceId, 120);
  if (!deviceId) throw new Error('EMPTY_DEVICE_ID');
  const row = {
    deviceId,
    deviceName: s(body.deviceName, 120),
    platform: s(body.platform, 40),
    expoPushToken: s(body.expoPushToken, 300),
    settings: body.settings || {},
    ts: now()
  };
  if (!pool) {
    memory.devices.set(deviceId, row);
    return row;
  }
  await pool.query(`INSERT INTO devices (device_id, device_name, platform, expo_push_token, settings, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$6)
    ON CONFLICT (device_id) DO UPDATE SET device_name=$2, platform=$3, expo_push_token=$4, settings=$5, updated_at=$6`,
    [row.deviceId, row.deviceName, row.platform, row.expoPushToken, JSON.stringify(row.settings), row.ts]);
  return row;
}

async function listDevices() {
  if (!pool) return Array.from(memory.devices.values());
  const { rows } = await pool.query(`SELECT device_id AS "deviceId", expo_push_token AS "expoPushToken", settings FROM devices WHERE expo_push_token <> ''`);
  return rows;
}

async function insertAlert(alert) {
  if (!alert.title || !alert.price || !alert.url) throw new Error('EMPTY_ALERT_REQUIRED_FIELD');

  if (!pool) {
    const exists = memory.alerts.find(x => x.dedupeKey === alert.dedupeKey);
    if (exists) return { inserted: false, alert: exists };
    memory.alerts.unshift(alert);
    memory.alerts = memory.alerts.slice(0, 1000);
    return { inserted: true, alert };
  }

  const r = await pool.query(`INSERT INTO alerts (
    id,dedupe_key,source,section,title,option_text,price,avg_price,low_price,drop_pct,app_discount,card_text,url,original_url,product_id,item_id,vendor_item_id,raw,created_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
  ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
  [alert.id, alert.dedupeKey, alert.source, alert.section, alert.title, alert.option, alert.price, alert.avg, alert.low, alert.dropPct, alert.appDiscount, alert.cardText, alert.url, alert.originalUrl, alert.productId, alert.itemId, alert.vendorItemId, JSON.stringify(alert.raw), alert.createdAt]);

  return { inserted: r.rowCount > 0, alert };
}

function rowToAlert(r) {
  const raw = r.raw || {};
  const partnerUrl = raw.partnerUrl || raw.coupangPartnerUrl || raw.affiliateUrl || raw.shortUrl || raw.deepLink || '';
  return {
    id: r.id,
    dedupeKey: r.dedupe_key || r.dedupeKey,
    source: r.source,
    section: r.section,
    title: r.title,
    option: r.option_text || r.option,
    price: n(r.price),
    avg: n(r.avg_price || r.avg),
    low: n(r.low_price || r.low),
    dropPct: f(r.drop_pct || r.dropPct),
    appDiscount: f(r.app_discount || r.appDiscount),
    cardText: r.card_text || r.cardText || '',
    url: partnerUrl || r.url,
    originalUrl: r.original_url || raw.productUrl || r.originalUrl || '',
    productId: r.product_id || r.productId || '',
    itemId: r.item_id || r.itemId || '',
    vendorItemId: r.vendor_item_id || r.vendorItemId || '',
    createdAt: n(r.created_at || r.createdAt)
  };
}

async function getAlerts(limit = 100) {
  if (!pool) return memory.alerts.slice(0, limit);
  const { rows } = await pool.query(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT $1`, [Math.min(Math.max(n(limit), 1), 300)]);
  return rows.map(rowToAlert);
}

function deviceAllows(device, alert) {
  const st = device.settings || {};
  const cats = st.categories || {};
  const section = String(alert.section || '');
  const compactSection = section.replace(/\s+/g, '');
  const allowBigDeal = cats.bigDeal !== false && cats.urgent !== false;
  const allowNormal = cats.realtimeTrend !== false && cats.realtime !== false;
  const big = isBigAlert(alert);

  if (big && !allowBigDeal) return false;
  if (!big && !allowNormal) return false;
  if (compactSection.includes('골드') || compactSection.includes('골드박스')) return false;

  const kw = st.keywords || {};
  const text = `${alert.title} ${alert.option}`.toLowerCase();
  const include = String(kw.include || '').split(',').map(x => x.trim()).filter(Boolean);
  const exclude = String(kw.exclude || '').split(',').map(x => x.trim()).filter(Boolean);
  if (exclude.some(k => text.includes(k.toLowerCase()))) return false;
  if (include.length && !include.some(k => text.includes(k.toLowerCase()))) return false;
  return true;
}

async function sendPush(alert) {
  const devices = await listDevices();
  const messages = [];
  for (const d of devices) {
    const token = d.expoPushToken;
    if (!token || !Expo.isExpoPushToken(token)) continue;
    if (!deviceAllows(d, alert)) continue;
    messages.push({
      to: token,
      sound: 'default',
      title: pushTitle(alert),
      body: pushMessage(alert),
      data: { alertId: alert.id, url: alert.url, kind: isBigAlert(alert) ? 'big' : 'hotdeal', message: pushCompactText(alert) },
      channelId: 'hotdeal',
      priority: 'high'
    });
  }
  const tickets = [];
  for (const chunk of expo.chunkPushNotifications(messages)) {
    const sent = await expo.sendPushNotificationsAsync(chunk);
    tickets.push(...sent);
  }
  return { sent: messages.length, tickets };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'WOWDROP_CENTRAL', app: 'KUHOT', version: 'v021-text-parser-fix', mode: pool ? 'postgres' : 'memory', time: now() });
});

app.post('/devices/register', async (req, res) => {
  try { res.json({ ok: true, device: await registerDevice(req.body || {}) }); }
  catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

app.get('/alerts', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, alerts: await getAlerts(req.query.limit || 100) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});


app.get('/alerts/:id', async (req, res) => {
  try {
    const alertId = s(req.params.id, 120);
    const alerts = await getAlerts(300);
    const found = alerts.find(a => String(a.id) === alertId);
    if (!found) return res.status(404).json({ ok: false, error: 'ALERT_NOT_FOUND' });
    res.json({ ok: true, alert: found });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post(['/telegram/ingest', '/telegram-ingest'], async (req, res) => {
  try {
    if (!allowIngest(req, res)) return;
    const body = req.body || {};
    const text = body.text || body.message || body.caption || '';
    const alert = text ? parseTelegramText(text, body) : normalizeAlert({ ...body, source: body.source || 'telegram_bridge' });
    const result = await insertAlert(alert);
    const push = result.inserted ? await sendPush(alert) : { sent: 0, duplicate: true };
    res.json({ ok: true, bridge: 'telegram', inserted: result.inserted, duplicate: !result.inserted, alert, push });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/ingest', async (req, res) => {
  try {
    if (!allowIngest(req, res)) return;
    const alert = normalizeAlert(req.body || {});
    const result = await insertAlert(alert);
    const push = result.inserted ? await sendPush(alert) : { sent: 0, duplicate: true };
    const telegram = result.inserted ? await sendTelegram(alert) : { sent: false, duplicate: true };
    res.json({ ok: true, inserted: result.inserted, duplicate: !result.inserted, alert, push, telegram });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/alert-open', async (req, res) => {
  try {
    const row = { id: id('open'), alertId: s(req.body.alertId, 120), deviceId: s(req.body.deviceId, 120), url: s(req.body.url, 1000), openedAt: now() };
    if (!pool) memory.opens.unshift(row);
    else await pool.query(`INSERT INTO alert_opens (id, alert_id, device_id, url, opened_at) VALUES ($1,$2,$3,$4,$5)`, [row.id, row.alertId, row.deviceId, row.url, row.openedAt]);
    res.json({ ok: true, open: row });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/push/test', async (req, res) => {
  try {
    const alert = normalizeAlert({
      source: 'test',
      section: req.body.section || '실시간인기',
      title: req.body.title || '쿠핫 테스트 알림',
      option: req.body.option || '푸시 테스트',
      price: req.body.price || 7450,
      avg: req.body.avg || 10375,
      low: req.body.low || 8600,
      appDiscount: req.body.appDiscount || 31,
      url: req.body.url || 'https://link.coupang.com/'
    });
    const push = await sendPush(alert);
    res.json({ ok: true, alert, push });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'NOT_FOUND',
    path: req.path,
    service: 'WOWDROP_CENTRAL',
    marker: 'WOWDROP_JSON_404_FALLBACK'
  });
});

app.use((err, req, res, next) => {
  console.error('[wowdrop-central] error', err);
  res.status(500).json({
    ok: false,
    error: String(err?.message || err),
    service: 'WOWDROP_CENTRAL'
  });
});

await initDb();
app.listen(PORT, () => console.log(`[wowdrop-central] listening :${PORT} mode=${pool ? 'postgres' : 'memory'}`));
