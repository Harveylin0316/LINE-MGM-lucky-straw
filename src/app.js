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
const { registerWebRoutes } = require('./routes/web');
const { registerLiffRoutes } = require('./routes/liff');
const { createLineWebhookHandler } = require('./routes/lineWebhook');

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
const LINE_OFFICIAL_ADD_FRIEND_URL = process.env.LINE_OFFICIAL_ADD_FRIEND_URL || '';
const LIFF_INVITE_BONUS_MAX = Number.parseInt(process.env.LIFF_INVITE_BONUS_MAX || '20', 10);
const LIFF_LINE_USER_BCRYPT_ROUNDS = Number.parseInt(process.env.LIFF_LINE_USER_BCRYPT_ROUNDS || '6', 10);
/** 自訂 LIFF 兌換說明（可含換行）；未設定則使用預設文案 */
const LIFF_REDEMPTION_NOTE = process.env.LIFF_REDEMPTION_NOTE || '';
/** LIFF 內「官方活動／完整辦法」超連結（預設：OpenRice 春日活動頁） */
const LIFF_CAMPAIGN_PAGE_URL =
  process.env.LIFF_CAMPAIGN_PAGE_URL || 'https://tinyurl.com/mv3f9wfv';

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

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

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

let initError = null;
const initPromise = initDb({
  query,
  adminUsername: ADMIN_USERNAME,
  adminPassword: ADMIN_PASSWORD
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
    inviteBonusMax: Number.isFinite(LIFF_INVITE_BONUS_MAX) ? LIFF_INVITE_BONUS_MAX : 20
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

app.use('/login', authLimiter);
app.use(ADMIN_LOGIN_PATH, authLimiter);
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
  adminLoginPath: ADMIN_LOGIN_PATH
});

registerLiffRoutes(app, {
  query,
  pool,
  authCore,
  lotteryCore,
  viewStateCore,
  liffId: LIFF_ID,
  lineChannelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
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
