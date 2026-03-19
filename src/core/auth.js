const jwt = require('jsonwebtoken');

function createAuthCore({ jwtSecret, isProduction, adminLoginPath = '/admin/login' }) {
  function signAuthToken(user) {
    return jwt.sign(
      { uid: user.id, un: user.username, adm: user.is_admin === true || user.is_admin === 1 },
      jwtSecret,
      { expiresIn: '7d' }
    );
  }

  function setAuthCookie(res, token) {
    res.cookie('auth_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
  }

  function clearAuthCookie(res) {
    res.clearCookie('auth_token');
  }

  function authMiddleware(req, _res, next) {
    const token = req.cookies.auth_token;
    if (!token) {
      req.authUser = null;
      return next();
    }
    try {
      req.authUser = jwt.verify(token, jwtSecret);
    } catch (_err) {
      req.authUser = null;
    }
    next();
  }

  function requireLogin(req, res, next) {
    if (!req.authUser || !req.authUser.uid) return res.redirect(adminLoginPath);
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.authUser || !req.authUser.adm) {
      if (req.authUser && !req.authUser.adm) {
        clearAuthCookie(res);
      }
      return res.status(404).send('Not found');
    }
    next();
  }

  return {
    signAuthToken,
    setAuthCookie,
    clearAuthCookie,
    authMiddleware,
    requireLogin,
    requireAdmin
  };
}

module.exports = { createAuthCore };
