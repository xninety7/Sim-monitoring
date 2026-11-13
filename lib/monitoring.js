// Automatic SIM monitoring: agents on each Mac report the phones plugged into them, and this module
// turns those reports into per-slot SIM states (present, removed, changed) shown on the dashboard.
import { randomBytes } from 'node:crypto';

// A phone counts as offline once its agent hasn't reported it for this long (agents report every 30s).
const offlineAfterSeconds = 90;

const platformLabels = { android: 'Android', ios: 'iPhone' };

function phoneName(platform, model, hardwareId) {
  const label = platformLabels[platform];
  const name = model || hardwareId;
  return name.toLowerCase().startsWith(label.toLowerCase()) ? name : `${label} ${name}`;
}

function isShortText(value, maxLength, required = false) {
  if (value === undefined || value === null) return !required;
  return typeof value === 'string' && value.length <= maxLength && (!required || value.trim().length > 0);
}

function validateReport(body) {
  if (!Array.isArray(body?.phones) || body.phones.length > 50) return 'phones must be an array of up to 50 phones.';
  for (const phone of body.phones) {
    if (!Object.hasOwn(platformLabels, phone?.platform)) return 'platform must be android or ios.';
    if (!isShortText(phone.hardwareId, 100, true)) return 'hardwareId is required.';
    if (![phone.model, phone.osVersion, phone.problem].every((value) => isShortText(value, 200))) {
      return 'model, osVersion and problem must be short strings.';
    }
    if (phone.slots === undefined) continue;
    if (!Array.isArray(phone.slots) || phone.slots.length > 4) return 'slots must be an array of up to 4 SIMs.';
    const seen = new Set();
    for (const sim of phone.slots) {
      if (!Number.isInteger(sim?.slot) || sim.slot < 1 || sim.slot > 4 || seen.has(sim.slot)) {
        return 'Each SIM needs a unique slot from 1 to 4.';
      }
      seen.add(sim.slot);
      if (![sim.simKey, sim.simLabel, sim.carrier, sim.phoneNumber].every((value) => isShortText(value, 100))) {
        return 'SIM fields must be short strings.';
      }
    }
  }
  return null;
}

function toSlot(row) {
  return {
    slotNumber: Number(row.slot_number),
    state: row.state,
    simLabel: row.sim_label,
    carrier: row.carrier,
    phoneNumber: row.phone_number,
    expectedSimLabel: row.baseline_sim_label,
    expectedCarrier: row.baseline_carrier,
    changedAt: row.changed_at,
  };
}

function toPhone(row, slots) {
  return {
    id: Number(row.id),
    platform: row.platform,
    hardwareId: row.hardware_id,
    model: row.model,
    osVersion: row.os_version,
    agentName: row.agent_name,
    deviceId: row.device_id === null ? null : Number(row.device_id),
    assetCode: row.asset_code ?? null,
    connected: row.connected,
    problem: row.problem,
    lastSeenAt: row.last_seen_at,
    slots: slots.map(toSlot),
  };
}

// Decides a slot's new state from the SIM now reported in it (or none), and what to log.
function nextSlot(row, sim, isNewPhone) {
  const key = sim?.simKey || null;
  const label = sim?.simLabel || sim?.carrier || null;
  const current = { sim_key: key, sim_label: label, carrier: sim?.carrier || null, phone_number: sim?.phoneNumber || null };

  if (!sim) {
    if (!row || row.state === 'removed' || row.state === 'empty') return null;
    return { ...row, ...current, state: 'removed', event: ['SIM removed', `expected ${row.baseline_sim_label || row.sim_label || 'a SIM'}`] };
  }
  if (!row) {
    const base = { ...current, state: 'present', baseline_sim_key: key, baseline_sim_label: label, baseline_carrier: current.carrier };
    return { ...base, event: isNewPhone ? null : ['SIM inserted', label || 'unknown SIM'] };
  }
  if (!row.baseline_sim_key || !key) {
    // No known identity to compare against: accept this SIM as the expected one.
    const wasOut = row.state === 'removed' || row.state === 'empty';
    return {
      ...row,
      ...current,
      state: 'present',
      baseline_sim_key: row.baseline_sim_key || key,
      baseline_sim_label: row.baseline_sim_key ? row.baseline_sim_label : label,
      baseline_carrier: row.baseline_sim_key ? row.baseline_carrier : current.carrier,
      event: wasOut ? ['SIM inserted', label || 'unknown SIM'] : null,
    };
  }
  if (key === row.baseline_sim_key) {
    const event = row.state === 'removed' ? ['SIM put back', label]
      : row.state === 'changed' ? ['Original SIM back', label] : null;
    return { ...row, ...current, state: 'present', event };
  }
  const alreadyFlagged = row.state === 'changed' && row.sim_key === key;
  return {
    ...row,
    ...current,
    state: 'changed',
    event: alreadyFlagged ? null : ['SIM changed', `${row.baseline_sim_label || 'expected SIM'} → ${label || 'unknown SIM'}`],
  };
}

export function registerMonitoring(app, { pool, logActivity, requireAdmin, sendDatabaseError, hashToken }) {
  async function loadPhones(where, params) {
    const phones = await pool.query(
      `SELECT phones.*, agents.name AS agent_name, devices.device_name AS asset_code
       FROM phones
       LEFT JOIN agents ON agents.id = phones.agent_id
       LEFT JOIN devices ON devices.id = phones.device_id
       ${where}
       ORDER BY phones.connected DESC, phones.last_seen_at DESC NULLS LAST, phones.id`,
      params,
    );
    if (!phones.rowCount) return [];
    const slots = await pool.query(
      'SELECT * FROM phone_slots WHERE phone_id = ANY($1::bigint[]) ORDER BY slot_number',
      [phones.rows.map((row) => row.id)],
    );
    return phones.rows.map((row) => toPhone(row, slots.rows.filter((slot) => slot.phone_id === row.id)));
  }

  // Logs events after the report is committed, naming each phone by its asset code when linked.
  async function logPhoneEvents(actorName, events) {
    if (!events.length) return;
    // Postgres returns BIGINT ids as strings; compare them as numbers.
    const phoneIds = [...new Set(events.map((event) => Number(event.phoneId)))];
    const phones = await loadPhones('WHERE phones.id = ANY($1::bigint[])', [phoneIds]);
    const names = new Map(phones.map((phone) => [
      phone.id,
      phone.assetCode || `${phoneName(phone.platform, phone.model, phone.hardwareId)} (not linked)`,
    ]));
    for (const event of events) {
      await logActivity({ actorName }, event.action, `${names.get(Number(event.phoneId)) || 'Unknown phone'}: ${event.text}`);
    }
  }

  async function applyPhone(client, agent, phone, events) {
    const existing = await client.query(
      'SELECT id, connected, problem FROM phones WHERE platform = $1 AND hardware_id = $2 FOR UPDATE',
      [phone.platform, phone.hardwareId],
    );
    const before = existing.rows[0];
    const problem = phone.problem || null;
    const result = await client.query(
      `INSERT INTO phones (platform, hardware_id, model, os_version, agent_id, connected, problem, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, now())
       ON CONFLICT (platform, hardware_id) DO UPDATE SET
         model = COALESCE(EXCLUDED.model, phones.model),
         os_version = COALESCE(EXCLUDED.os_version, phones.os_version),
         agent_id = EXCLUDED.agent_id, connected = true, problem = EXCLUDED.problem, last_seen_at = now()
       RETURNING id`,
      [phone.platform, phone.hardwareId, phone.model || null, phone.osVersion || null, agent.id, problem],
    );
    const phoneId = result.rows[0].id;

    if (!before) {
      events.push({ phoneId, action: 'Phone detected', text: `on ${agent.name}` });
    } else if (!before.connected) {
      events.push({ phoneId, action: 'Phone connected', text: `on ${agent.name}` });
    }
    if (problem && problem !== before?.problem) events.push({ phoneId, action: 'Phone needs attention', text: problem });

    // A phone that can't be read (e.g. USB debugging not allowed) says nothing about its SIMs.
    if (problem) return phoneId;

    const known = await client.query('SELECT * FROM phone_slots WHERE phone_id = $1 FOR UPDATE', [phoneId]);
    const rows = new Map(known.rows.map((row) => [Number(row.slot_number), row]));
    const sims = new Map((phone.slots || []).map((sim) => [sim.slot, sim]));
    for (const slotNumber of [...new Set([...rows.keys(), ...sims.keys()])].sort()) {
      const next = nextSlot(rows.get(slotNumber), sims.get(slotNumber), !before);
      if (!next) continue;
      const stateChanged = next.state !== rows.get(slotNumber)?.state;
      await client.query(
        `INSERT INTO phone_slots (phone_id, slot_number, state, sim_key, sim_label, carrier, phone_number,
                                  baseline_sim_key, baseline_sim_label, baseline_carrier, changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (phone_id, slot_number) DO UPDATE SET
           state = EXCLUDED.state, sim_key = EXCLUDED.sim_key, sim_label = EXCLUDED.sim_label,
           carrier = EXCLUDED.carrier, phone_number = EXCLUDED.phone_number,
           baseline_sim_key = EXCLUDED.baseline_sim_key, baseline_sim_label = EXCLUDED.baseline_sim_label,
           baseline_carrier = EXCLUDED.baseline_carrier,
           changed_at = CASE WHEN $11 THEN now() ELSE phone_slots.changed_at END`,
        [phoneId, slotNumber, next.state, next.sim_key, next.sim_label, next.carrier, next.phone_number,
          next.baseline_sim_key, next.baseline_sim_label, next.baseline_carrier, stateChanged],
      );
      if (next.event) events.push({ phoneId, action: next.event[0], text: `slot ${slotNumber}: ${next.event[1]}` });
    }
    return phoneId;
  }

  app.post('/api/agent/report', async (req, res) => {
    const token = req.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) return res.status(401).json({ error: 'Missing agent key.' });
    const validationError = validateReport(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const client = await pool.connect();
    const events = [];
    let agent;
    try {
      await client.query('BEGIN');
      const agentResult = await client.query(
        'UPDATE agents SET last_report_at = now() WHERE token_hash = $1 RETURNING id, name',
        [hashToken(token)],
      );
      if (!agentResult.rowCount) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Unknown agent key.' });
      }
      agent = agentResult.rows[0];
      const reportedIds = [];
      for (const phone of req.body.phones) reportedIds.push(await applyPhone(client, agent, phone, events));
      // Phones this Mac reported before but not now were unplugged.
      const unplugged = await client.query(
        `UPDATE phones SET connected = false
         WHERE agent_id = $1 AND connected AND NOT (id = ANY($2::bigint[])) RETURNING id`,
        [agent.id, reportedIds],
      );
      for (const row of unplugged.rows) events.push({ phoneId: row.id, action: 'Phone disconnected', text: `unplugged from ${agent.name}` });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      return sendDatabaseError(res, error);
    } finally {
      client.release();
    }
    await logPhoneEvents(`${agent.name} (agent)`, events);
    return res.json({ ok: true });
  });

  app.get('/api/phones', async (_req, res) => {
    try {
      res.json(await loadPhones('', []));
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  app.patch('/api/phones/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const deviceId = req.body?.deviceId;
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid phone id.' });
    if (deviceId !== null && (!Number.isSafeInteger(deviceId) || deviceId <= 0)) {
      return res.status(400).json({ error: 'deviceId must be an asset id or null.' });
    }
    try {
      const result = await pool.query('UPDATE phones SET device_id = $2 WHERE id = $1 RETURNING id', [id, deviceId]);
      if (!result.rowCount) return res.status(404).json({ error: 'Phone not found.' });
      const [phone] = await loadPhones('WHERE phones.id = $1', [id]);
      const name = phoneName(phone.platform, phone.model, phone.hardwareId);
      await logActivity(req, deviceId ? 'Linked phone' : 'Unlinked phone', deviceId ? `${name} → ${phone.assetCode}` : name);
      res.json(phone);
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That asset already has a phone linked.' });
      if (error.code === '23503') return res.status(404).json({ error: 'Asset not found.' });
      sendDatabaseError(res, error);
    }
  });

  app.delete('/api/phones/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid phone id.' });
    try {
      const result = await pool.query('DELETE FROM phones WHERE id = $1 RETURNING platform, model, hardware_id', [id]);
      if (!result.rowCount) return res.status(404).json({ error: 'Phone not found.' });
      const row = result.rows[0];
      await logActivity(req, 'Removed phone', phoneName(row.platform, row.model, row.hardware_id));
      res.status(204).end();
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  // Any signed-in user can confirm a SIM change or removal so the slot stops showing a warning.
  app.post('/api/phones/:id/slots/:slot/accept', async (req, res) => {
    const id = Number(req.params.id);
    const slot = Number(req.params.slot);
    if (!Number.isSafeInteger(id) || id <= 0 || ![1, 2, 3, 4].includes(slot)) {
      return res.status(400).json({ error: 'Invalid phone or slot.' });
    }
    try {
      const result = await pool.query(
        `UPDATE phone_slots SET
           state = CASE state WHEN 'changed' THEN 'present' ELSE 'empty' END,
           baseline_sim_key = CASE state WHEN 'changed' THEN sim_key END,
           baseline_sim_label = CASE state WHEN 'changed' THEN sim_label END,
           baseline_carrier = CASE state WHEN 'changed' THEN carrier END,
           changed_at = now()
         WHERE phone_id = $1 AND slot_number = $2 AND state IN ('changed', 'removed')
         RETURNING state`,
        [id, slot],
      );
      if (!result.rowCount) return res.status(400).json({ error: 'That slot has no SIM change to confirm.' });
      const [phone] = await loadPhones('WHERE phones.id = $1', [id]);
      const name = phone.assetCode || phoneName(phone.platform, phone.model, phone.hardwareId);
      const accepted = result.rows[0].state === 'present';
      await logActivity(req, accepted ? 'Accepted new SIM' : 'Confirmed SIM removal', `${name}: slot ${slot}`);
      res.json(phone);
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  app.get('/api/agents', requireAdmin, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT agents.id, agents.name, agents.created_at, agents.last_report_at,
               count(phones.id) FILTER (WHERE phones.connected)::int AS connected_phones
        FROM agents LEFT JOIN phones ON phones.agent_id = agents.id
        GROUP BY agents.id ORDER BY agents.name
      `);
      res.json(result.rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        createdAt: row.created_at,
        lastReportAt: row.last_report_at,
        connectedPhones: row.connected_phones,
      })));
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  // The agent key is shown once; only its hash is stored.
  app.post('/api/agents', requireAdmin, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 50) return res.status(400).json({ error: 'Give the Mac a name of up to 50 characters, e.g. PC-9.' });
    const token = `sma_${randomBytes(32).toString('base64url')}`;
    try {
      const result = await pool.query(
        `INSERT INTO agents (name, token_hash) VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING RETURNING id, name, created_at`,
        [name, hashToken(token)],
      );
      if (!result.rowCount) return res.status(409).json({ error: 'A Mac with that name already exists.' });
      await logActivity(req, 'Created agent key', name);
      res.status(201).json({ id: Number(result.rows[0].id), name, token });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  app.delete('/api/agents/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid agent id.' });
    try {
      await pool.query('UPDATE phones SET connected = false WHERE agent_id = $1', [id]);
      const result = await pool.query('DELETE FROM agents WHERE id = $1 RETURNING name', [id]);
      if (!result.rowCount) return res.status(404).json({ error: 'Agent not found.' });
      await logActivity(req, 'Revoked agent key', result.rows[0].name);
      res.status(204).end();
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });

  return {
    // Monitoring details for the dashboard, keyed by asset id.
    async loadMonitorsByDevice(deviceIds) {
      const phones = await loadPhones('WHERE phones.device_id = ANY($1::bigint[])', [deviceIds]);
      return new Map(phones.map((phone) => [phone.deviceId, phone]));
    },

    // Marks phones offline when their Mac stops reporting (asleep, switched off, agent stopped).
    startOfflineSweep() {
      const timer = setInterval(async () => {
        try {
          const result = await pool.query(
            `UPDATE phones SET connected = false
             WHERE connected AND last_seen_at < now() - make_interval(secs => $1)
             RETURNING id, (SELECT name FROM agents WHERE agents.id = phones.agent_id) AS agent_name`,
            [offlineAfterSeconds],
          );
          await logPhoneEvents('System', result.rows.map((row) => ({
            phoneId: row.id,
            action: 'Phone offline',
            text: `no report from ${row.agent_name || 'its Mac'}`,
          })));
        } catch (error) {
          console.error('Offline check failed:', error.message);
        }
      }, 30_000);
      timer.unref();
    },
  };
}
