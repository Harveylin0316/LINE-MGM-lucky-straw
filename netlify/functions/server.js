const serverless = require('serverless-http');
const app = require('../../server');

module.exports.handler = serverless(app, {
  // Ensure binary assets (images/fonts) are returned as base64 payloads
  // so Netlify/Lambda does not corrupt bytes by treating them as UTF-8 text.
  binary: ['image/*', 'font/*', 'application/octet-stream']
});
