import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  phoneNumber: 'phone_number',
  anydeskId: 'anydesk_id',
  color: 'color',
  telcoProvider: 'telco_provider',
  status: 'status',
  lastSeen: 'last_seen',
  simNumber: 'sim_number',
  iccid: 'iccid',
  imei: 'imei',
};

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(currentDir, { index: 'index.html' }));

function toDevice(row) {
  return {
    id: Number(row.id),
    deviceName: row.device_name,
    attachedPc: row.attached_pc,
    phoneNumber: row.phone_number,
    anydeskId: row.anydesk_id,
    color: row.color,
    telcoProvider: row.telco_provider,
    status: row.status,
    lastSeen: row.last_seen,
    ...(row.sim_number ? { simNumber: row.sim_number } : {}),
    ...(row.iccid ? { iccid: row.iccid } : {}),
    ...(row.imei ? { imei: row.imei } : {}),
  };
}

function validateDevice(input, { requireAll = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'Request body must be a JSON object.';
  }

  for (const field of ['deviceName', 'attachedPc', 'phoneNumber']) {
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

  for (const field of ['anydeskId', 'color', 'telcoProvider', 'simNumber', 'iccid', 'imei']) {
    if (input[field] !== undefined && input[field] !== null && typeof input[field] !== 'string') {
      return `${field} must be a string or null.`;
    }
  }

  return null;
}

function sendDatabaseError(res, error) {
  if (error.code === '23505') {
    return res.status(409).json({ error: 'That SIM identifier is already assigned to another device.' });
  }
  console.error('Database request failed:', error);
  return res.status(500).json({ error: 'Database request failed.' });
}

async function logActivity(req, action, details) {
  const actor = req.get('X-Authenticated-User')?.trim().slice(0, 100) || 'Unknown user';
  try {
    await pool.query(
      'INSERT INTO activity_log (actor, action, details) VALUES ($1, $2, $3)',
      [actor, action, details.slice(0, 500)],
    );
  } catch (error) {
    console.error('Could not write activity log:', error.message);
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

app.get('/api/activity', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, actor, action, details, created_at AS "createdAt"
      FROM activity_log
      ORDER BY id DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/devices', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, device_name, attached_pc, phone_number, anydesk_id, color, telco_provider, status, last_seen,
             sim_number, iccid, imei
      FROM devices
      ORDER BY id
    `);
    res.json(result.rows.map(toDevice));
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
      await client.query(
        `INSERT INTO devices
           (device_name, attached_pc, phone_number, anydesk_id, color, telco_provider, status, last_seen, sim_number, iccid, imei)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          device.deviceName.trim(),
          device.attachedPc.trim(),
          device.phoneNumber.trim(),
          device.anydeskId?.trim() || null,
          device.color?.trim() || null,
          device.telcoProvider?.trim() || null,
          device.status || 'inactive',
          device.lastSeen || '',
          device.simNumber || null,
          device.iccid || null,
          device.imei || null,
        ],
      );
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

  try {
    const { deviceName, attachedPc, phoneNumber, anydeskId, color, telcoProvider, status, lastSeen, simNumber, iccid, imei } = req.body;
    const result = await pool.query(
      `INSERT INTO devices
         (device_name, attached_pc, phone_number, anydesk_id, color, telco_provider, status, last_seen, sim_number, iccid, imei)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, device_name, attached_pc, phone_number, anydesk_id, color, telco_provider, status, last_seen, sim_number, iccid, imei`,
      [deviceName.trim(), attachedPc.trim(), phoneNumber.trim(), anydeskId?.trim() || null, color?.trim() || null, telcoProvider?.trim() || null, status || 'inactive', lastSeen || '', simNumber || null, iccid || null, imei || null],
    );
    await logActivity(req, 'Added asset', deviceName.trim());
    res.status(201).json(toDevice(result.rows[0]));
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.patch('/api/devices/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid device id.' });

  const validationError = validateDevice(req.body, { requireAll: false });
  if (validationError) return res.status(400).json({ error: validationError });

  const keys = Object.keys(req.body);
  if (!keys.length || keys.some((key) => !Object.hasOwn(deviceFields, key))) {
    return res.status(400).json({ error: 'Provide at least one supported device field.' });
  }

  const values = keys.map((key) => {
    const value = req.body[key];
    if (typeof value === 'string' && key !== 'lastSeen') return value.trim();
    return value;
  });
  const assignments = keys.map((key, index) => `${deviceFields[key]} = $${index + 1}`);

  try {
    const result = await pool.query(
      `UPDATE devices SET ${assignments.join(', ')}, updated_at = now()
       WHERE id = $${keys.length + 1}
      RETURNING id, device_name, attached_pc, phone_number, anydesk_id, color, telco_provider, status, last_seen, sim_number, iccid, imei`,
      [...values, id],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Device not found.' });
    const deviceName = result.rows[0].device_name;
    await logActivity(req, 'Updated asset', `Asset code ${deviceName}: ${keys.join(', ')}`);
    res.json(toDevice(result.rows[0]));
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.post('/api/devices/:id/switch-sim', async (req, res) => {
  const sourceId = Number(req.params.id);
  const targetId = Number(req.body?.targetId);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || !Number.isSafeInteger(targetId) || targetId <= 0 || sourceId === targetId) {
    return res.status(400).json({ error: 'Choose two different, valid device IDs.' });
  }
  if (req.body?.simNumber !== undefined && (typeof req.body.simNumber !== 'string' || !req.body.simNumber.trim())) {
    return res.status(400).json({ error: 'simNumber must be a non-empty string when provided.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, device_name, attached_pc, phone_number, status, last_seen, sim_number, iccid, imei
       FROM devices WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [[sourceId, targetId]],
    );
    if (result.rows.length !== 2) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Source or destination device not found.' });
    }

    const sourceRow = result.rows.find((row) => Number(row.id) === sourceId);
    const targetRow = result.rows.find((row) => Number(row.id) === targetId);
    const sourceHasSim = Boolean(sourceRow.sim_number || sourceRow.iccid || sourceRow.imei);

    if (!sourceHasSim && !req.body.simNumber?.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The source has no SIM assignment. Provide its SIM number.' });
    }

    const sourceSim = sourceRow.sim_number || (sourceHasSim ? null : req.body.simNumber.trim());
    const sourceIccid = sourceRow.iccid;
    const sourceImei = sourceRow.imei;

    await client.query(
      `UPDATE devices SET sim_number = NULL, iccid = NULL, imei = NULL, updated_at = now()
       WHERE id = ANY($1::bigint[])`,
      [[sourceId, targetId]],
    );
    await client.query(
      `UPDATE devices SET sim_number = $1, iccid = $2, imei = $3, updated_at = now() WHERE id = $4`,
      [targetRow.sim_number, targetRow.iccid, targetRow.imei, sourceId],
    );
    await client.query(
      `UPDATE devices SET sim_number = $1, iccid = $2, imei = $3, updated_at = now() WHERE id = $4`,
      [sourceSim, sourceIccid, sourceImei, targetId],
    );

    await client.query('COMMIT');
    await logActivity(req, 'Switched SIM', `${sourceRow.device_name} ↔ ${targetRow.device_name}`);
    res.json({ switched: true, sourceId, targetId });
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
      INSERT INTO devices (device_name, attached_pc, phone_number, status, last_seen, sim_number, iccid, imei)
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
        to_char(now() - ((i - 1) * interval '2 hours'), 'Mon DD, HH12:MI AM'),
        'SIM-' || lpad((9999 + i)::text, 5, '0'),
        '8931' || lpad((1000000000 + (i - 1) * 17)::text, 10, '0'),
        '35' || lpad((100000000000 + (i - 1) * 97)::text, 12, '0')
      FROM generate_series(1, 115) AS i
      WHERE NOT EXISTS (SELECT 1 FROM devices)
    `);
  }
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
