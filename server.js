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
  anydeskId: 'anydesk_id',
  color: 'color',
  telcoProvider: 'telco_provider',
  simSlotCount: 'sim_slot_count',
  status: 'status',
  lastSeen: 'last_seen',
};

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(currentDir, { index: 'index.html' }));

function toDevice(row) {
  return {
    id: Number(row.id),
    deviceName: row.device_name,
    attachedPc: row.attached_pc,
    anydeskId: row.anydesk_id,
    color: row.color,
    telcoProvider: row.telco_provider,
    simSlotCount: Number(row.sim_slot_count || 1),
    status: row.status,
    lastSeen: row.last_seen,
    sims: row.sims || [],
  };
}

function normalizeSimSlots(input) {
  if (Array.isArray(input.sims)) {
    return input.sims.map((sim) => ({
      slotNumber: Number(sim.slotNumber),
      phoneNumber: typeof sim.phoneNumber === 'string' ? sim.phoneNumber.trim() : null,
    })).filter((sim) => sim.phoneNumber);
  }

  // Accept older browser-import records that stored one phone number directly on the asset.
  if (typeof input.phoneNumber === 'string' && input.phoneNumber.trim()) {
    return [{
      slotNumber: 1,
      phoneNumber: input.phoneNumber.trim(),
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
      return `SIM slots must be unique and within the configured ${slotCount} slot${slotCount === 1 ? '' : 's'}.`;
    }
    seenSlots.add(sim.slotNumber);
    if (sim.phoneNumber !== undefined && sim.phoneNumber !== null && typeof sim.phoneNumber !== 'string') {
      return 'phoneNumber in each SIM slot must be a string or null.';
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
      `INSERT INTO device_sims (device_id, slot_number, phone_number)
       VALUES ($1, $2, $3)`,
      [deviceId, sim.slotNumber, sim.phoneNumber || null],
    );
  }
}

async function loadDevicesWithSims(deviceRows) {
  if (!deviceRows.length) return [];
  const simResult = await pool.query(
    `SELECT device_id, slot_number, phone_number
     FROM device_sims WHERE device_id = ANY($1::bigint[]) ORDER BY slot_number`,
    [deviceRows.map((row) => row.id)],
  );
  const simsByDevice = new Map();
  for (const row of simResult.rows) {
    const sims = simsByDevice.get(Number(row.device_id)) || [];
    sims.push({
      slotNumber: Number(row.slot_number),
      phoneNumber: row.phone_number,
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
      SELECT id, device_name, attached_pc, anydesk_id, color, telco_provider,
             sim_slot_count, status, last_seen
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
           (device_name, attached_pc, anydesk_id, color, telco_provider, sim_slot_count, status, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          device.deviceName.trim(),
          device.attachedPc.trim(),
          device.anydeskId?.trim() || null,
          device.color?.trim() || null,
          device.telcoProvider?.trim() || null,
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
    const { deviceName, attachedPc, anydeskId, color, telcoProvider, status, lastSeen } = req.body;
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await client.query(
        `INSERT INTO devices
           (device_name, attached_pc, anydesk_id, color, telco_provider, sim_slot_count, status, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, device_name, attached_pc, anydesk_id, color, telco_provider, sim_slot_count, status, last_seen`,
        [deviceName.trim(), attachedPc.trim(), anydeskId?.trim() || null, color?.trim() || null, telcoProvider?.trim() || null, req.body.simSlotCount || 1, status || 'inactive', lastSeen || ''],
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
        return res.status(400).json({ error: 'Move or clear the occupied SIM slot before reducing the slot count.' });
      }
    }

    let updatedRow;
    if (keys.length) {
      const result = await client.query(
        `UPDATE devices SET ${assignments.join(', ')}, updated_at = now()
         WHERE id = $${keys.length + 1}
         RETURNING id, device_name, attached_pc, anydesk_id, color, telco_provider, sim_slot_count, status, last_seen`,
        [...values, id],
      );
      updatedRow = result.rows[0];
    } else {
      const result = await client.query(
        `SELECT id, device_name, attached_pc, anydesk_id, color, telco_provider, sim_slot_count, status, last_seen
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

app.post('/api/devices/:id/switch-sim', async (req, res) => {
  const sourceId = Number(req.params.id);
  const targetId = Number(req.body?.targetId);
  const sourceSlot = Number(req.body?.sourceSlot);
  const targetSlot = Number(req.body?.targetSlot);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || !Number.isSafeInteger(targetId) || targetId <= 0 || sourceId === targetId) {
    return res.status(400).json({ error: 'Choose two different, valid assets.' });
  }
  if (![1, 2].includes(sourceSlot) || ![1, 2].includes(targetSlot)) {
    return res.status(400).json({ error: 'Choose valid source and destination SIM slots.' });
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
      return res.status(400).json({ error: 'The selected slot is not configured for that asset.' });
    }

    const slots = await client.query(
      `SELECT device_id, slot_number, phone_number
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

    const targetPhoneNumber = targetSim?.phone_number ? targetSim : null;

    await client.query(
      `DELETE FROM device_sims
       WHERE (device_id = $1 AND slot_number = $2) OR (device_id = $3 AND slot_number = $4)`,
      [sourceId, sourceSlot, targetId, targetSlot],
    );
    await client.query(
      `INSERT INTO device_sims (device_id, slot_number, phone_number)
       VALUES ($1, $2, $3)`,
      [targetId, targetSlot, sourceSim.phone_number],
    );
    if (targetPhoneNumber) {
      await client.query(
        `INSERT INTO device_sims (device_id, slot_number, phone_number)
         VALUES ($1, $2, $3)`,
        [sourceId, sourceSlot, targetPhoneNumber.phone_number],
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
