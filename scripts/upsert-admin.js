const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
const username = process.argv[2] || 'admin';
const password = process.argv[3] || '1234';

if (!databaseUrl) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

async function run() {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const hash = await bcrypt.hash(password, 10);
    const sql =
      'INSERT INTO users (username, password_hash, draws_left, is_admin) VALUES ($1, $2, 1, true) ' +
      'ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_admin = true ' +
      'RETURNING id, username, is_admin';
    const result = await pool.query(sql, [username, hash]);
    console.log(JSON.stringify(result.rows[0]));
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error(err.message);
  process.exit(1);
});
