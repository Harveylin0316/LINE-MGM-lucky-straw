const PORT = process.env.PORT || 3000;
const app = require('./src/app');

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;

