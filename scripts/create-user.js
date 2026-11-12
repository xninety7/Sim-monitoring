// Creates a user, or resets the password of an existing one.
// Usage: npm run create-user -- <username> [--admin]
// Use --admin for the first account; after that, manage users from the Users page.
import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword, isValidPassword, isValidUsername, passwordRule, usernameRule } from '../lib/passwords.js';

const args = process.argv.slice(2);
const makeAdmin = args.includes('--admin');
const username = String(args.find((arg) => !arg.startsWith('--')) || '').trim().toLowerCase();
if (!isValidUsername(username)) {
  console.error('Usage: npm run create-user -- <username> [--admin]');
  console.error(usernameRule);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
      if (text.includes(question)) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const password = await promptHidden(`Password for ${username}: `);
if (!isValidPassword(password)) {
  console.error(passwordRule);
  process.exit(1);
}
if (password !== await promptHidden('Confirm password: ')) {
  console.error('Passwords do not match.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined,
});
try {
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql');
  await pool.query(await readFile(schemaPath, 'utf8'));
  // Without --admin, an existing user's admin flag is left unchanged.
  const result = await pool.query(
    `INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, is_admin = users.is_admin OR EXCLUDED.is_admin
     RETURNING (xmax = 0) AS created, id, is_admin`,
    [username, await hashPassword(password), makeAdmin],
  );
  const { created, id, is_admin: isAdmin } = result.rows[0];
  if (!created) {
    // A password reset signs the user out everywhere.
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  }
  const role = isAdmin ? 'admin' : 'user';
  console.log(created ? `Created ${role} ${username}.` : `Reset password for ${role} ${username}.`);
} finally {
  await pool.end();
}
