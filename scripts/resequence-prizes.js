const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('data.db');

db.all('SELECT name, quantity, weight, created_at FROM prizes ORDER BY id ASC', (readErr, rows) => {
  if (readErr) {
    console.error(readErr.message);
    process.exit(1);
  }

  db.serialize(() => {
    const rollback = err => {
      db.run('ROLLBACK', () => {
        console.error(err.message);
        process.exit(1);
      });
    };

    db.run('BEGIN TRANSACTION', beginErr => {
      if (beginErr) return rollback(beginErr);

      db.run('DELETE FROM prizes', deleteErr => {
        if (deleteErr) return rollback(deleteErr);

        const stmt = db.prepare(
          'INSERT INTO prizes (id, name, quantity, weight, created_at) VALUES (?, ?, ?, ?, ?)'
        );

        rows.forEach((row, index) => {
          stmt.run(index + 1, row.name, row.quantity, row.weight || 1, row.created_at);
        });

        stmt.finalize(finalizeErr => {
          if (finalizeErr) return rollback(finalizeErr);

          db.run("DELETE FROM sqlite_sequence WHERE name = 'prizes'", seqDeleteErr => {
            if (seqDeleteErr) return rollback(seqDeleteErr);

            const commit = () => {
              db.run('COMMIT', commitErr => {
                if (commitErr) return rollback(commitErr);

                db.all('SELECT id, name, quantity FROM prizes ORDER BY id ASC', (checkErr, checkRows) => {
                  if (checkErr) {
                    console.error(checkErr.message);
                    process.exit(1);
                  }
                  console.log(JSON.stringify(checkRows));
                  db.close();
                });
              });
            };

            if (rows.length > 0) {
              db.run(
                "INSERT INTO sqlite_sequence (name, seq) VALUES ('prizes', ?)",
                [rows.length],
                seqInsertErr => {
                  if (seqInsertErr) return rollback(seqInsertErr);
                  commit();
                }
              );
              return;
            }

            commit();
          });
        });
      });
    });
  });
});
