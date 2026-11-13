import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashPassword,
  isValidPassword,
  isValidUsername,
  passwordRule,
  usernameRule,
  verifyPassword,
} from './lib/passwords.js';

const { Pool } = pg;
const app = express();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8000);
const databaseUrl = process.env.DATABASE_URL;
const currentDir = path.dirname(fileURLToPath(import.meta.url));

if (!databaseUrl) {
  console.error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

const allowedStatuses = new Set(['active', 'inactive', 'offline', 'suspended']);
const deviceFields = {
  deviceName: 'device_name',
  attachedPc: 'attached_pc',
  anydeskId: 'anydesk_id',
  color: 'color',
  simSlotCount: 'sim_slot_count',
  status: 'status',
  lastSeen: 'last_seen',
};

const sessionCookie = 'sid';
const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;
const publicPaths = new Set(['/login.html', '/login.js', '/styles.css', '/api/login', '/api/health']);
const loginAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const maxLoginFailures = 10;
const dummyPasswordHash = hashPassword(randomBytes(16).toString('hex'));
const liveClients = new Set();
// Below Nginx's 30s proxy_read_timeout so idle live connections stay open.
const liveKeepAliveMs = 25_000;

app.disable('x-powered-by');
// Nginx terminates TLS on the same host; trust its X-Forwarded-Proto so secure cookies work.
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '32kb' }));
app.use(async (req, res, next) => {
  try {
    req.user = await findSessionUser(req);
  } catch (error) {
    return sendDatabaseError(res, error);
  }
  if (req.user && req.path === '/login.html') return res.redirect('/');
  if (req.user && req.path === '/admin.html' && !req.user.is_admin) return res.redirect('/');
  if (req.user || publicPaths.has(req.path)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please sign in.' });
  return res.redirect('/login.html');
});
app.use(express.static(currentDir, { index: 'index.html' }));

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function readSessionToken(req) {
  const match = new RegExp(`(?:^|;\\s*)${sessionCookie}=([^;]+)`).exec(req.get('Cookie') || '');
  return match?.[1];
}

async function findSessionUser(req) {
  const token = readSessionToken(req);
  if (!token) return null;
  const result = await pool.query(
    `SELECT users.id, users.username, users.is_admin
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1 AND sessions.expires_at > now()`,
    [hashToken(token)],
  );
  return result.rows[0] || null;
}

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Only admins can manage users.' });
  return next();
}

function toUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    isAdmin: row.is_admin,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function isLoginBlocked(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  if (Date.now() - attempt.firstAt > loginWindowMs) {
    loginAttempts.delete(key);
    return false;
  }
  return attempt.count >= maxLoginFailures;
}

function recordLoginFailure(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt || Date.now() - attempt.firstAt > loginWindowMs) {
    loginAttempts.set(key, { count: 1, firstAt: Date.now() });
  } else {
    attempt.count += 1;
  }
}

function toDevice(row) {
  return {
    id: Number(row.id),
    deviceName: row.device_name,
    attachedPc: row.attached_pc,
    anydeskId: row.anydesk_id,
    color: row.color,
    simSlotCount: Number(row.sim_slot_count || 1),
    status: row.status,
    lastSeen: row.last_seen,
    lastCheckedAt: row.last_checked_at,
    lastCheckedBy: row.last_checked_by,
    sims: row.sims || [],
  };
}

function normalizeSimSlots(input) {
  if (Array.isArray(input.sims)) {
    const sims = input.sims.map((sim) => ({
      slotNumber: Number(sim.slotNumber),
      phoneNumber: typeof sim.phoneNumber === 'string' ? sim.phoneNumber.trim() : null,
      telcoProvider: typeof sim.telcoProvider === 'string' ? sim.telcoProvider.trim() : null,
    })).filter((sim) => sim.phoneNumber || sim.telcoProvider);
    const legacyProvider = typeof input.telcoProvider === 'string' ? input.telcoProvider.trim() : '';
    if (legacyProvider && !sims.some((sim) => sim.slotNumber === 1 && sim.telcoProvider)) {
      const firstSlot = sims.find((sim) => sim.slotNumber === 1);
      if (firstSlot) firstSlot.telcoProvider = legacyProvider;
      else sims.push({ slotNumber: 1, phoneNumber: null, telcoProvider: legacyProvider });
    }
    return sims;
  }

  // Accept older browser-import records that stored one phone number directly on the asset.
  if (typeof input.phoneNumber === 'string' && input.phoneNumber.trim()) {
    return [{
      slotNumber: 1,
      phoneNumber: input.phoneNumber.trim(),
      telcoProvider: input.telcoProvider?.trim() || null,
    }];
  }
  return [];
}

function validateSimSlots(input) {
  if (input.simSlotCount !== undefined && ![1, 2].includes(input.simSlotCount)) {
    return 'simSlotCount must be 1 or 2.';
  }
  if (input.sims === undefined) return null;
  if (!Array.isArray(input.sims)) return 'sims must be an array.';
  const slotCount = input.simSlotCount || 2;
  const seenSlots = new Set();
  for (const sim of input.sims) {
    if (!sim || typeof sim !== 'object' || Array.isArray(sim)) return 'Each SIM slot must be an object.';
    if (![1, 2].includes(sim.slotNumber) || sim.slotNumber > slotCount || seenSlots.has(sim.slotNumber)) {
      return `Phone number slots must be unique and within the configured ${slotCount} slot${slotCount === 1 ? '' : 's'}.`;
    }
    seenSlots.add(sim.slotNumber);
    if (sim.phoneNumber !== undefined && sim.phoneNumber !== null && typeof sim.phoneNumber !== 'string') {
      return 'phoneNumber in each SIM slot must be a string or null.';
    }
    if (sim.telcoProvider !== undefined && sim.telcoProvider !== null && typeof sim.telcoProvider !== 'string') {
      return 'telcoProvider in each phone-number slot must be a string or null.';
    }
  }
  return null;
}

function validateDevice(input, { requireAll = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'Request body must be a JSON object.';
  }

  for (const field of ['deviceName', 'attachedPc']) {
    if (requireAll && (typeof input[field] !== 'string' || !input[field].trim())) {
      return `${field} is required.`;
    }
    if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field].trim())) {
      return `${field} must be a non-empty string.`;
    }
  }

  if (input.status !== undefined && !allowedStatuses.has(input.status)) {
    return 'status must be active, inactive, offline, or suspended.';
  }
  if (input.lastSeen !== undefined && typeof input.lastSeen !== 'string') {
    return 'lastSeen must be a string.';
  }

  for (const field of ['anydeskId', 'color', 'telcoProvider', 'phoneNumber']) {
    if (input[field] !== undefined && input[field] !== null && typeof input[field] !== 'string') {
      return `${field} must be a string or null.`;
    }
  }

  const simError = validateSimSlots(input);
  if (simError) return simError;

  return null;
}

async function insertSimSlots(client, deviceId, sims) {
  for (const sim of sims) {
    await client.query(
      `INSERT INTO device_sims (device_id, slot_number, phone_number, telco_provider)
       VALUES ($1, $2, $3, $4)`,
      [deviceId, sim.slotNumber, sim.phoneNumber || null, sim.telcoProvider || null],
    );
  }
}

async function loadDevicesWithSims(deviceRows) {
  if (!deviceRows.length) return [];
  const simResult = await pool.query(
    `SELECT device_id, slot_number, phone_number, telco_provider
     FROM device_sims WHERE device_id = ANY($1::bigint[]) ORDER BY slot_number`,
    [deviceRows.map((row) => row.id)],
  );
  const simsByDevice = new Map();
  for (const row of simResult.rows) {
    const sims = simsByDevice.get(Number(row.device_id)) || [];
    sims.push({
      slotNumber: Number(row.slot_number),
      phoneNumber: row.phone_number,
      telcoProvider: row.telco_provider,
    });
    simsByDevice.set(Number(row.device_id), sims);
  }
  return deviceRows.map((row) => toDevice({
    ...row,
    sims: simsByDevice.get(Number(row.id)) || [],
  }));
}

function sendDatabaseError(res, error) {
  if (error.code === '23505') {
    return res.status(409).json({ error: 'That phone number is already assigned to another slot.' });
  }
  console.error('Database request failed:', error);
  return res.status(500).json({ error: 'Database request failed.' });
}

function getActor(req) {
  return req.user?.username || 'Unknown user';
}

// Every successful change is logged here, so this is also where open pages get told to refresh.
async function logActivity(req, action, details) {
  try {
    await pool.query(
      'INSERT INTO activity_log (actor, action, details) VALUES ($1, $2, $3)',
      [getActor(req), action, details.slice(0, 500)],
    );
  } catch (error) {
    console.error('Could not write activity log:', error.message);
  }
  broadcastChange(action);
}

function broadcastChange(action) {
  const message = `event: change\ndata: ${JSON.stringify({ action })}\n\n`;
  for (const res of liveClients) {
    if (!res.writableEnded) res.write(message);
  }
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.post('/api/login', async (req, res) => {
  if (isLoginBlocked(req.ip)) {
    return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
  }
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password || password.length > 200) {
    return res.status(400).json({ error: 'Enter your username and password.' });
  }

  try {
    const result = await pool.query('SELECT id, username, password_hash FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    // Verify against a dummy hash for unknown users so response time doesn't reveal which usernames exist.
    const passwordMatches = await verifyPassword(password, user?.password_hash ?? await dummyPasswordHash);
    if (!user || !passwordMatches) {
      recordLoginFailure(req.ip);
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }

    loginAttempts.delete(req.ip);
    const token = randomBytes(32).toString('base64url');
    await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [hashToken(token), user.id, sessionMaxAgeSeconds],
    );
    res.cookie(sessionCookie, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: sessionMaxAgeSeconds * 1000,
      path: '/',
    });
    res.json({ username: user.username });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.post('/api/logout', async (req, res) => {
  const token = readSessionToken(req);
  try {
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    res.clearCookie(sessionCookie, { path: '/' });
    res.status(204).end();
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/me', (req, res) => {
  res.json({ username: req.user.username, isAdmin: req.user.is_admin });
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  liveClients.add(res);

  // Also end the stream once the session is gone (logout, account deleted, expiry).
  const keepAlive = setInterval(async () => {
    try {
      if (!(await findSessionUser(req))) {
        if (!res.writableEnded) res.end();
        return;
      }
    } catch {
      // Keep the stream open through a brief database error.
    }
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, liveKeepAliveMs);

  req.on('close', () => {
    clearInterval(keepAlive);
    liveClients.delete(res);
  });
});

app.get('/api/users', requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, is_admin, created_at, last_login_at FROM users ORDER BY username',
    );
    res.json(result.rows.map(toUser));
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const { password, isAdmin = false } = req.body ?? {};
  if (!isValidUsername(username)) return res.status(400).json({ error: usernameRule });
  if (!isValidPassword(password)) return res.status(400).json({ error: passwordRule });
  if (typeof isAdmin !== 'boolean') return res.status(400).json({ error: 'isAdmin must be true or false.' });

  try {
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username, is_admin, created_at, last_login_at`,
      [username, await hashPassword(password), isAdmin],
    );
    if (!result.rowCount) return res.status(409).json({ error: 'That username is already taken.' });
    await logActivity(req, 'Created user', `${username}${isAdmin ? ' (admin)' : ''}`);
    res.status(201).json(toUser(result.rows[0]));
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  const { password, isAdmin } = req.body ?? {};
  if (password === undefined && isAdmin === undefined) {
    return res.status(400).json({ error: 'Provide a new password or admin setting.' });
  }
  if (password !== undefined && !isValidPassword(password)) return res.status(400).json({ error: passwordRule });
  if (isAdmin !== undefined && typeof isAdmin !== 'boolean') {
    return res.status(400).json({ error: 'isAdmin must be true or false.' });
  }
  // Admins can't demote themselves, so there is always at least one admin left.
  if (isAdmin === false && id === Number(req.user.id)) {
    return res.status(400).json({ error: "You can't remove your own admin access." });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET password_hash = COALESCE($2, password_hash), is_admin = COALESCE($3, is_admin)
       WHERE id = $1
       RETURNING id, username, is_admin, created_at, last_login_at`,
      [id, password === undefined ? null : await hashPassword(password), isAdmin ?? null],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'User not found.' });
    const changes = [];
    if (password !== undefined) {
      // Sign the user out everywhere, except the admin's own current session.
      await pool.query(
        'DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2',
        [id, hashToken(readSessionToken(req))],
      );
      changes.push('password reset');
    }
    if (isAdmin !== undefined) changes.push(isAdmin ? 'made admin' : 'admin access removed');
    await logActivity(req, 'Updated user', `${result.rows[0].username}: ${changes.join(', ')}`);
    res.json(toUser(result.rows[0]));
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  if (id === Number(req.user.id)) return res.status(400).json({ error: "You can't delete your own account." });

  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING username', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'User not found.' });
    await logActivity(req, 'Deleted user', result.rows[0].username);
    res.status(204).end();
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/activity', async (req, res) => {
  const pageSize = 10;
  const requestedPage = Number.parseInt(req.query.page, 10);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  try {
    const [countResult, eventsResult] = await Promise.all([
      pool.query('SELECT count(*)::int AS total FROM activity_log'),
      pool.query(`
      SELECT id, actor, action, details, created_at AS "createdAt"
      FROM activity_log
      ORDER BY id DESC
      LIMIT $1 OFFSET $2
      `, [pageSize, (page - 1) * pageSize]),
    ]);
    const total = countResult.rows[0].total;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (page > pageCount) return res.status(404).json({ error: 'Activity page not found.' });
    res.json({ events: eventsResult.rows, total, page, pageSize, pageCount });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/devices', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, device_name, attached_pc, anydesk_id, color,
              sim_slot_count, status, last_seen, last_checked_at, last_checked_by
      FROM devices
      ORDER BY id
    `);
    res.json(await loadDevicesWithSims(result.rows));
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.post('/api/devices/import', async (req, res) => {
  const { devices } = req.body ?? {};
  if (!Array.isArray(devices) || devices.length > 5000) {
    return res.status(400).json({ error: 'devices must be an array of up to 5000 records.' });
  }

  for (const device of devices) {
    const validationError = validateDevice(device);
    if (validationError) return res.status(400).json({ error: validationError });
    const simError = validateSimSlots({ ...device, simSlotCount: device.simSlotCount || 1 });
    if (simError) return res.status(400).json({ error: simError });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const countResult = await client.query('SELECT count(*)::int AS count FROM devices');
    if (countResult.rows[0].count !== 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Import is only allowed when the shared device list is empty.' });
    }

    for (const device of devices) {
      const result = await client.query(
        `INSERT INTO devices
           (device_name, attached_pc, anydesk_id, color, sim_slot_count, status, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          device.deviceName.trim(),
          device.attachedPc.trim(),
          device.anydeskId?.trim() || null,
          device.color?.trim() || null,
          device.simSlotCount || 1,
          device.status || 'inactive',
          device.lastSeen || '',
        ],
      );
      await insertSimSlots(client, result.rows[0].id, normalizeSimSlots(device));
    }

    await client.query('COMMIT');
    await logActivity(req, 'Imported devices', `${devices.length} device record${devices.length === 1 ? '' : 's'}`);
    return res.status(201).json({ imported: devices.length });
  } catch (error) {
    await client.query('ROLLBACK');
    return sendDatabaseError(res, error);
  } finally {
    client.release();
  }
});

app.post('/api/devices', async (req, res) => {
  const validationError = validateDevice(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  const simError = validateSimSlots({ ...req.body, simSlotCount: req.body.simSlotCount || 1 });
  if (simError) return res.status(400).json({ error: simError });

  try {
    const { deviceName, attachedPc, anydeskId, color, status, lastSeen } = req.body;
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await client.query(
        `INSERT INTO devices
           (device_name, attached_pc, anydesk_id, color, sim_slot_count, status, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, device_name, attached_pc, anydesk_id, color, sim_slot_count, status, last_seen, last_checked_at, last_checked_by`,
        [deviceName.trim(), attachedPc.trim(), anydeskId?.trim() || null, color?.trim() || null, req.body.simSlotCount || 1, status || 'inactive', lastSeen || ''],
      );
      await insertSimSlots(client, result.rows[0].id, normalizeSimSlots(req.body));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await logActivity(req, 'Added asset', deviceName.trim());
    const [device] = await loadDevicesWithSims(result.rows);
    res.status(201).json(device);
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.patch('/api/devices/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid device id.' });

  const validationError = validateDevice(req.body, { requireAll: false });
  if (validationError) return res.status(400).json({ error: validationError });

  const { sims, ...deviceInput } = req.body;
  const keys = Object.keys(deviceInput);
  if ((!keys.length && sims === undefined) || keys.some((key) => !Object.hasOwn(deviceFields, key))) {
    return res.status(400).json({ error: 'Provide at least one supported device field.' });
  }

  const values = keys.map((key) => {
    const value = req.body[key];
    if (typeof value === 'string' && key !== 'lastSeen') return value.trim();
    return value;
  });
  const assignments = keys.map((key, index) => `${deviceFields[key]} = $${index + 1}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      'SELECT id, device_name, sim_slot_count FROM devices WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!currentResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Device not found.' });
    }
    const current = currentResult.rows[0];
    const nextSlotCount = deviceInput.simSlotCount ?? Number(current.sim_slot_count);
    if (sims !== undefined) {
      const simError = validateSimSlots({ simSlotCount: nextSlotCount, sims });
      if (simError) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: simError });
      }
    }
    if (nextSlotCount < Number(current.sim_slot_count) && sims === undefined) {
      const occupied = await client.query(
        'SELECT 1 FROM device_sims WHERE device_id = $1 AND slot_number > $2 AND phone_number IS NOT NULL LIMIT 1',
        [id, nextSlotCount],
      );
      if (occupied.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Move or clear the phone number in the second slot before reducing the slot count.' });
      }
    }

    let updatedRow;
    if (keys.length) {
      const result = await client.query(
        `UPDATE devices SET ${assignments.join(', ')}, updated_at = now()
         WHERE id = $${keys.length + 1}
         RETURNING id, device_name, attached_pc, anydesk_id, color, sim_slot_count, status, last_seen, last_checked_at, last_checked_by`,
        [...values, id],
      );
      updatedRow = result.rows[0];
    } else {
      const result = await client.query(
        `SELECT id, device_name, attached_pc, anydesk_id, color, sim_slot_count, status, last_seen, last_checked_at, last_checked_by
         FROM devices WHERE id = $1`,
        [id],
      );
      updatedRow = result.rows[0];
    }

    if (sims !== undefined) {
      await client.query('DELETE FROM device_sims WHERE device_id = $1', [id]);
      await insertSimSlots(client, id, normalizeSimSlots({ sims }));
    }
    await client.query('COMMIT');
    await logActivity(req, 'Updated asset', `Asset code ${updatedRow.device_name}: ${[...keys, ...(sims !== undefined ? ['SIM slots'] : [])].join(', ')}`);
    const [device] = await loadDevicesWithSims([updatedRow]);
    res.json(device);
  } catch (error) {
    await client.query('ROLLBACK');
    sendDatabaseError(res, error);
  } finally {
    client.release();
  }
});

app.post('/api/devices/:id/check', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid device id.' });

  try {
    const result = await pool.query(
      `UPDATE devices SET last_checked_at = now(), last_checked_by = $1
       WHERE id = $2
       RETURNING id, device_name, attached_pc, anydesk_id, color, sim_slot_count, status, last_seen, last_checked_at, last_checked_by`,
      [getActor(req), id],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Device not found.' });
    await logActivity(req, 'Checked asset', result.rows[0].device_name);
    const [device] = await loadDevicesWithSims(result.rows);
    res.json(device);
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.post('/api/devices/:id/switch-sim', async (req, res) => {
  const sourceId = Number(req.params.id);
  const targetId = Number(req.body?.targetId);
  const sourceSlot = Number(req.body?.sourceSlot);
  const targetSlot = Number(req.body?.targetSlot);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || !Number.isSafeInteger(targetId) || targetId <= 0 || sourceId === targetId) {
    return res.status(400).json({ error: 'Choose two different, valid assets.' });
  }
  if (![1, 2].includes(sourceSlot) || ![1, 2].includes(targetSlot)) {
    return res.status(400).json({ error: 'Choose valid source and destination phone-number slots.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const devices = await client.query(
      `SELECT id, device_name, sim_slot_count FROM devices
       WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [[sourceId, targetId]],
    );
    if (devices.rows.length !== 2) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Source or destination asset not found.' });
    }
    const source = devices.rows.find((device) => Number(device.id) === sourceId);
    const target = devices.rows.find((device) => Number(device.id) === targetId);
    if (sourceSlot > Number(source.sim_slot_count) || targetSlot > Number(target.sim_slot_count)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The selected phone-number slot is not configured for that asset.' });
    }

    const slots = await client.query(
      `SELECT device_id, slot_number, phone_number, telco_provider
       FROM device_sims
       WHERE (device_id = $1 AND slot_number = $2) OR (device_id = $3 AND slot_number = $4)
       FOR UPDATE`,
      [sourceId, sourceSlot, targetId, targetSlot],
    );
    const sourceSim = slots.rows.find((sim) => Number(sim.device_id) === sourceId && Number(sim.slot_number) === sourceSlot);
    const targetSim = slots.rows.find((sim) => Number(sim.device_id) === targetId && Number(sim.slot_number) === targetSlot);
    if (!sourceSim?.phone_number) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Source slot ${sourceSlot} has no phone number.` });
    }

    const targetPhoneNumber = targetSim?.phone_number || targetSim?.telco_provider ? targetSim : null;

    await client.query(
      `DELETE FROM device_sims
       WHERE (device_id = $1 AND slot_number = $2) OR (device_id = $3 AND slot_number = $4)`,
      [sourceId, sourceSlot, targetId, targetSlot],
    );
    await client.query(
      `INSERT INTO device_sims (device_id, slot_number, phone_number, telco_provider)
       VALUES ($1, $2, $3, $4)`,
      [targetId, targetSlot, sourceSim.phone_number, sourceSim.telco_provider],
    );
    if (targetPhoneNumber) {
      await client.query(
        `INSERT INTO device_sims (device_id, slot_number, phone_number, telco_provider)
         VALUES ($1, $2, $3, $4)`,
        [sourceId, sourceSlot, targetPhoneNumber.phone_number, targetPhoneNumber.telco_provider],
      );
    }

    await client.query('COMMIT');
    const outcome = targetPhoneNumber ? 'swapped with' : 'moved to';
    await logActivity(req, targetPhoneNumber ? 'Swapped phone numbers' : 'Moved phone number', `${source.device_name} slot ${sourceSlot} ${outcome} ${target.device_name} slot ${targetSlot}`);
    res.json({ switched: true, sourceId, sourceSlot, targetId, targetSlot, swapped: Boolean(targetPhoneNumber) });
  } catch (error) {
    await client.query('ROLLBACK');
    sendDatabaseError(res, error);
  } finally {
    client.release();
  }
});

app.delete('/api/devices/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid device id.' });

  try {
    const result = await pool.query('DELETE FROM devices WHERE id = $1 RETURNING id, device_name', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Device not found.' });
    await logActivity(req, 'Deleted asset', result.rows[0].device_name);
    res.status(204).end();
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

async function initializeDatabase() {
  const schema = await readFile(path.join(currentDir, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);

  if (process.env.SEED_DEMO_DATA === 'true') {
    await pool.query(`
      INSERT INTO devices (device_name, attached_pc, phone_number, status, last_seen)
      SELECT
        CASE (i - 1) % 17
          WHEN 0 THEN 'Alpha' WHEN 1 THEN 'Bravo' WHEN 2 THEN 'Charlie' WHEN 3 THEN 'Delta'
          WHEN 4 THEN 'Echo' WHEN 5 THEN 'Foxtrot' WHEN 6 THEN 'Golf' WHEN 7 THEN 'Hotel'
          WHEN 8 THEN 'India' WHEN 9 THEN 'Juliet' WHEN 10 THEN 'Kilo' WHEN 11 THEN 'Lima'
          WHEN 12 THEN 'Mike' WHEN 13 THEN 'November' WHEN 14 THEN 'Oscar' WHEN 15 THEN 'Papa'
          ELSE 'Quebec' END || '-' || lpad(i::text, 3, '0'),
        'PC-' || lpad((((i - 1) % 15) + 1)::text, 2, '0'),
        '+1 415 ' || lpad((199 + i)::text, 3, '0') || ' ' || lpad((1000 + ((i - 1) * 7) % 9000)::text, 4, '0'),
        CASE ((i - 1) * 3 + 1) % 4 WHEN 0 THEN 'active' WHEN 1 THEN 'inactive' WHEN 2 THEN 'offline' ELSE 'suspended' END,
        to_char(now() - ((i - 1) * interval '2 hours'), 'Mon DD, HH12:MI AM')
      FROM generate_series(1, 115) AS i
      WHERE NOT EXISTS (SELECT 1 FROM devices)
    `);
  }

  // Keep the legacy bootstrap seed compatible by copying asset-level phone numbers into slot 1.
  await pool.query(`
    INSERT INTO device_sims (device_id, slot_number, phone_number)
    SELECT id, 1, phone_number FROM devices WHERE phone_number IS NOT NULL
    ON CONFLICT (device_id, slot_number) DO NOTHING
  `);
  await pool.query(`
    UPDATE device_sims AS slots
    SET phone_number = devices.phone_number
    FROM devices
    WHERE slots.device_id = devices.id AND slots.slot_number = 1
      AND devices.phone_number IS NOT NULL AND slots.phone_number IS NULL
  `);
  await pool.query('UPDATE devices SET phone_number = NULL WHERE phone_number IS NOT NULL');
}

async function start() {
  await initializeDatabase();
  app.listen(port, host, () => {
    console.log(`SIM Monitoring dashboard and API listening on http://${host}:${port}`);
  });
}

start().catch(async (error) => {
  console.error('Could not initialize PostgreSQL:', error.message);
  await pool.end();
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await pool.end();
    process.exit(0);
  });
}
