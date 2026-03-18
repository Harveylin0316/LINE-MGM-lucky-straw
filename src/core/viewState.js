function createViewStateCore({ query, isProduction }) {
  const availablePrizesCacheTtlMs = isProduction ? 5000 : 0;
  let availablePrizesCache = {
    value: null,
    expiresAt: 0
  };

  function setDrawResultCookie(res, resultText) {
    res.cookie('lottery_draw_result', resultText, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 2 * 60 * 1000
    });
  }

  function consumeDrawResultCookie(req, res) {
    const result = req.cookies.lottery_draw_result;
    if (result) {
      res.clearCookie('lottery_draw_result');
    }
    return result || null;
  }

  function invalidateAvailablePrizesCache() {
    availablePrizesCache = { value: null, expiresAt: 0 };
  }

  async function getAvailablePrizes(runQuery = query, options = {}) {
    const { forceRefresh = false } = options;
    const canReadWriteCache = runQuery === query && availablePrizesCacheTtlMs > 0;
    const now = Date.now();
    if (
      canReadWriteCache &&
      !forceRefresh &&
      Array.isArray(availablePrizesCache.value) &&
      availablePrizesCache.expiresAt > now
    ) {
      return availablePrizesCache.value;
    }
    const result = await runQuery('SELECT name FROM prizes WHERE quantity > 0 ORDER BY id ASC LIMIT 200');
    if (canReadWriteCache) {
      availablePrizesCache = {
        value: result.rows || [],
        expiresAt: now + availablePrizesCacheTtlMs
      };
    }
    return result.rows || [];
  }

  function buildRefLink(req, userId) {
    const host = req.get('host');
    if (!host) return `/register?ref=${userId}`;
    return `${req.protocol}://${host}/register?ref=${userId}`;
  }

  function parsePage(value) {
    const page = Number.parseInt(value, 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
  }

  return {
    setDrawResultCookie,
    consumeDrawResultCookie,
    invalidateAvailablePrizesCache,
    getAvailablePrizes,
    buildRefLink,
    parsePage
  };
}

module.exports = { createViewStateCore };
