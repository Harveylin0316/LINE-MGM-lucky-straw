const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const { createAuthCore } = require('./core/auth');
const { pickPrizeByQuantity, enrichPrizesWithHitRate } = require('./core/lottery');
const { createViewStateCore } = require('./core/viewState');
const { initDb } = require('./core/dbInit');
const { createAdminLoginThrottle } = require('./core/adminLoginThrottle');
const { registerWebRoutes } = require('./routes/web');
const { registerLiffRoutes } = require('./routes/liff');
const { createLineWebhookHandler } = require('./routes/lineWebhook');
const { createLinePushService } = require('./core/linePush');

const isProduction = process.env.NODE_ENV === 'production';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (isProduction ? '' : 'LocalAdmin1234');
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SESSION_SECRET ||
  (isProduction ? '' : 'local-dev-only-jwt-secret-change-before-production-123');
const DATABASE_URL = process.env.DATABASE_URL;
const LIFF_ID = process.env.LIFF_ID || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_OFFICIAL_ADD_FRIEND_URL_RAW = process.env.LINE_OFFICIAL_ADD_FRIEND_URL || '';

/**
 * LINE@ 加好友連結必須為絕對網址。若設成相對路徑（例如 liff/xxx），在 /liff/{邀請碼} 頁面上會變成 /liff/liff/xxx 而 404。
 */
function normalizeLineOfficialAddFriendUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  let candidate = s;
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^\/\//.test(candidate)) {
      candidate = `https:${candidate}`;
    } else if (/^line\.me\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return '';
    }
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch {
    return '';
  }
}

const LINE_OFFICIAL_ADD_FRIEND_URL = normalizeLineOfficialAddFriendUrl(LINE_OFFICIAL_ADD_FRIEND_URL_RAW);
if (LINE_OFFICIAL_ADD_FRIEND_URL_RAW && !LINE_OFFICIAL_ADD_FRIEND_URL) {
  console.warn(
    'LINE_OFFICIAL_ADD_FRIEND_URL is set but invalid (use full https URL, e.g. https://line.me/R/ti/p/@xxx). Ignoring.'
  );
}
const LIFF_INVITE_BONUS_MAX = Number.parseInt(process.env.LIFF_INVITE_BONUS_MAX || '20', 10);
const LIFF_LINE_USER_BCRYPT_ROUNDS = Number.parseInt(process.env.LIFF_LINE_USER_BCRYPT_ROUNDS || '6', 10);
/** 自訂 LIFF 兌換說明（可含換行）；未設定則使用預設文案 */
const LIFF_REDEMPTION_NOTE = process.env.LIFF_REDEMPTION_NOTE || '';
/** LIFF 內「官方活動／完整辦法」超連結（預設：OpenRice 春日活動頁） */
const LIFF_CAMPAIGN_PAGE_URL =
  process.env.LIFF_CAMPAIGN_PAGE_URL || 'https://tinyurl.com/mv3f9wfv';

/** LINE push 圖片訊息需公開 HTTPS URL；未設定則中獎推播不含餐籃圖 */
function normalizeLinePushPublicBaseUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

const LINE_PUSH_PUBLIC_BASE_URL = normalizeLinePushPublicBaseUrl(
  process.env.LINE_PUSH_PUBLIC_BASE_URL || process.env.PUBLIC_SITE_URL || ''
);

function normalizeAdminLoginPath(rawPath) {
  const fallback = '/admin/login';
  if (typeof rawPath !== 'string') return fallback;
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/')) return fallback;
  if (trimmed.startsWith('//')) return fallback;
  if (trimmed.length < 8) return fallback;
  if (/[^a-zA-Z0-9/_-]/.test(trimmed)) return fallback;
  return trimmed;
}

const ADMIN_LOGIN_PATH = normalizeAdminLoginPath(process.env.ADMIN_LOGIN_PATH || '/admin/login');
const ADMIN_LOGIN_THROTTLE_WINDOW_MIN = Number.parseInt(process.env.ADMIN_LOGIN_THROTTLE_WINDOW_MIN || '15', 10);
const ADMIN_LOGIN_MAX_ATTEMPTS = Number.parseInt(process.env.ADMIN_LOGIN_MAX_ATTEMPTS || '8', 10);
const ADMIN_LOGIN_POST_RATE_MAX = Number.parseInt(process.env.ADMIN_LOGIN_POST_RATE_MAX || '10', 10);

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL. Please configure Postgres connection string.');
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('Missing or weak JWT_SECRET. Use at least 32 characters.');
}

function resolveAssetDir(dirName, expectedFile) {
  const candidates = [
    path.join(__dirname, '..', dirName),
    path.join(__dirname, '..', '..', dirName),
    path.join(process.cwd(), dirName),
    path.join('/var/task', dirName),
    path.join('/var/task', 'src', dirName)
  ];
  for (const candidate of candidates) {
    const target = expectedFile ? path.join(candidate, expectedFile) : candidate;
    if (fs.existsSync(target)) return candidate;
  }
  return path.join(__dirname, '..', dirName);
}

/** Netlify Function 單實例建議小 pool，降低冷啟動建連成本 */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: Number.parseInt(process.env.PG_POOL_MAX || '', 10) || (isProduction ? 2 : 10),
  connectionTimeoutMillis: Number.parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || '', 10) || 10000,
  idleTimeoutMillis: 20000
});

const skipDbDdlOnBoot = process.env.SKIP_DB_DDL_ON_BOOT === '1';

async function query(text, params = []) {
  return pool.query(text, params);
}

const authCore = createAuthCore({
  jwtSecret: JWT_SECRET,
  isProduction,
  adminLoginPath: ADMIN_LOGIN_PATH
});

const lotteryCore = {
  pickPrizeByQuantity,
  enrichPrizesWithHitRate
};

const viewStateCore = createViewStateCore({
  query,
  isProduction
});

const adminLoginThrottle = createAdminLoginThrottle({
  query,
  hmacSecret: JWT_SECRET,
  windowMinutes: ADMIN_LOGIN_THROTTLE_WINDOW_MIN,
  maxAttempts: ADMIN_LOGIN_MAX_ATTEMPTS
});

const linePush = createLinePushService({
  query,
  lineChannelAccessToken: LINE_CHANNEL_ACCESS_TOKEN
});

let initError = null;
const initPromise = initDb({
  query,
  adminUsername: ADMIN_USERNAME,
  adminPassword: ADMIN_PASSWORD,
  skipDdl: skipDbDdlOnBoot
}).catch(err => {
  initError = err;
  console.error('Database initialization failed:', err.message);
  return null;
});

const app = express();
const viewsDir = resolveAssetDir('views', 'index.ejs');
const publicDir = resolveAssetDir('public', 'style.css');

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', viewsDir);
app.use(
  express.static(publicDir, {
    maxAge: isProduction ? '1d' : 0,
    etag: true
  })
);
app.post(
  '/webhooks/line',
  express.raw({ type: 'application/json' }),
  createLineWebhookHandler({
    pool,
    channelSecret: LINE_CHANNEL_SECRET,
    inviteBonusMax: Number.isFinite(LIFF_INVITE_BONUS_MAX) ? LIFF_INVITE_BONUS_MAX : 20,
    linePush
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

const adminLoginPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.max(3, ADMIN_LOGIN_POST_RATE_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

const adminLoginGetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

app.use((req, res, next) => {
  if (req.path !== ADMIN_LOGIN_PATH) return next();
  if (req.method === 'POST') return adminLoginPostLimiter(req, res, next);
  if (req.method === 'GET') return adminLoginGetLimiter(req, res, next);
  return next();
});

app.use('/login', authLimiter);
app.use('/register', authLimiter);
app.use('/liff/auth', authLimiter);
app.use(authCore.authMiddleware);

app.use(async (_req, _res, next) => {
  try {
    await initPromise;
    if (initError) {
      throw initError;
    }
    next();
  } catch (err) {
    next(err);
  }
});

registerWebRoutes(app, {
  query,
  pool,
  authCore,
  lotteryCore,
  viewStateCore,
  adminLoginPath: ADMIN_LOGIN_PATH,
  adminLoginThrottle
});

registerLiffRoutes(app, {
  query,
  pool,
  authCore,
  lotteryCore,
  viewStateCore,
  liffId: LIFF_ID,
  linePush,
  linePushPublicBaseUrl: LINE_PUSH_PUBLIC_BASE_URL,
  inviteBonusMax: Number.isFinite(LIFF_INVITE_BONUS_MAX) ? LIFF_INVITE_BONUS_MAX : 20,
  lineOfficialAddFriendUrl: LINE_OFFICIAL_ADD_FRIEND_URL,
  lineUserPasswordHashRounds: Number.isFinite(LIFF_LINE_USER_BCRYPT_ROUNDS) ? LIFF_LINE_USER_BCRYPT_ROUNDS : 6,
  liffRedemptionNote: LIFF_REDEMPTION_NOTE,
  liffCampaignPageUrl: LIFF_CAMPAIGN_PAGE_URL
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).send('Server error');
});

module.exports = app;
