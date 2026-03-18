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

const isProduction = process.env.NODE_ENV === 'production';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (isProduction ? '' : 'LocalAdmin1234');
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SESSION_SECRET ||
  (isProduction ? '' : 'local-dev-only-jwt-secret-change-before-production-123');
const DATABASE_URL = process.env.DATABASE_URL;
const LIFF_ID = process.env.LIFF_ID || '';

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
  isProduction
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
  viewStateCore
});

registerLiffRoutes(app, {
  query,
  pool,
  authCore,
  lotteryCore,
  viewStateCore,
  liffId: LIFF_ID
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).send('Server error');
});

module.exports = app;
