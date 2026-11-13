// Reads the SIMs of phones plugged into this Mac over USB: Android via adb, iPhone via libimobiledevice.
// Only reads; nothing on the phones is changed.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Philippine mobile network codes (MCC + MNC).
const carriersByNetwork = { 51501: 'Globe', 51502: 'Globe', 51503: 'Smart', 51505: 'Sun', 51566: 'DITO' };
const knownCarriers = ['Globe', 'Smart', 'DITO', 'Sun', 'TNT', 'TM', 'GOMO'];
const presentSimStates = new Set(['READY', 'LOADED', 'PIN_REQUIRED', 'PUK_REQUIRED', 'NETWORK_LOCKED']);

async function tool(command, args) {
  try {
    const { stdout } = await run(command, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: stdout };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, missing: true, out: `${command} is not installed` };
    return { ok: false, out: `${error.stdout || ''}${error.stderr || ''}`.trim() || error.message };
  }
}

function carrierName(raw) {
  const text = String(raw || '').trim();
  return knownCarriers.find((name) => name.toLowerCase() === text.toLowerCase()) || text || null;
}

// Only a hash of the SIM serial leaves the Mac; the server just needs to tell SIMs apart.
function iccidKey(iccid) {
  return `iccid:${createHash('sha256').update(iccid).digest('hex').slice(0, 24)}`;
}

async function readAndroid(serial) {
  const phone = { platform: 'android', hardwareId: serial };
  const props = await tool('adb', ['-s', serial, 'shell', 'getprop']);
  if (!props.ok) return { ...phone, problem: 'Could not read the phone over USB' };
  const prop = (key) => props.out.match(new RegExp(`^\\[${key.replace(/\./g, '\\.')}\\]: \\[(.*)\\]$`, 'm'))?.[1] || '';
  phone.model = [prop('ro.product.manufacturer'), prop('ro.product.model')].filter(Boolean).join(' ') || null;
  phone.osVersion = prop('ro.build.version.release') ? `Android ${prop('ro.build.version.release')}` : null;
  const simStates = prop('gsm.sim.state').split(',');
  const carriers = prop('gsm.sim.operator.alpha').split(',');

  // Android gives each physical SIM it has seen a stable subscription id, keyed by the full ICCID,
  // so a slot whose id changes holds a different SIM even from the same carrier.
  const subscriptions = new Map();
  const isub = await tool('adb', ['-s', serial, 'shell', 'dumpsys', 'isub']);
  for (const match of (isub.out || '').matchAll(/\bid=(\d+) iccId=\S* simSlotIndex=(\d+)/g)) {
    subscriptions.set(Number(match[2]), match[1]);
  }
  // Older Android versions expose full ICCIDs to adb instead.
  const iccids = new Map();
  if (!subscriptions.size) {
    const siminfo = await tool('adb', ['-s', serial, 'shell', 'content', 'query', '--uri', 'content://telephony/siminfo']);
    for (const row of (siminfo.out || '').split('\n')) {
      const slot = Number(row.match(/(?:^|, )sim_id=(-?\d+)/)?.[1]);
      const iccid = row.match(/(?:^|, )icc_id=(\w+)/)?.[1];
      if (slot >= 0 && iccid) iccids.set(slot, iccid);
    }
  }

  phone.slots = [];
  const slotCount = Math.max(simStates.length, ...[...subscriptions.keys(), ...iccids.keys()].map((slot) => slot + 1));
  for (let index = 0; index < slotCount; index += 1) {
    const subscriptionId = subscriptions.get(index);
    const iccid = iccids.get(index);
    const present = subscriptionId || iccid || presentSimStates.has((simStates[index] || '').trim().toUpperCase());
    if (!present) continue;
    const carrier = carrierName(carriers[index]);
    phone.slots.push({
      slot: index + 1,
      simKey: subscriptionId ? `android-sub:${subscriptionId}` : iccid ? iccidKey(iccid) : null,
      simLabel: [carrier, subscriptionId ? `SIM #${subscriptionId}` : iccid ? `…${iccid.slice(-4)}` : null].filter(Boolean).join(' ') || null,
      carrier,
    });
  }
  return phone;
}

export async function readAndroidPhones() {
  const list = await tool('adb', ['devices']);
  if (!list.ok) return { phones: [], warning: list.out };
  const phones = [];
  for (const row of list.out.split('\n').slice(1)) {
    const [serial, state] = row.trim().split(/\s+/);
    if (!serial || !state) continue;
    if (state === 'device') phones.push(await readAndroid(serial));
    else if (state === 'unauthorized') phones.push({ platform: 'android', hardwareId: serial, problem: 'Tap "Allow" on the USB debugging prompt on the phone' });
    else phones.push({ platform: 'android', hardwareId: serial, problem: `Phone not ready (${state})` });
  }
  return { phones };
}

async function readIphone(udid) {
  const phone = { platform: 'ios', hardwareId: udid };
  const info = await tool('ideviceinfo', ['-u', udid]);
  if (!info.ok) {
    const needsTrust = /pair|trust|password/i.test(info.out);
    return { ...phone, problem: needsTrust ? 'Unlock the iPhone and tap "Trust This Computer"' : 'Could not read the iPhone over USB' };
  }
  const top = Object.fromEntries([...info.out.matchAll(/^(\w+): (.*)$/gm)].map((match) => [match[1], match[2]]));
  phone.model = top.DeviceName || top.ProductType || null;
  phone.osVersion = top.ProductVersion ? `iOS ${top.ProductVersion}` : null;

  // CarrierBundleInfoArray lists each active SIM (physical or eSIM) with its slot and serial.
  const bundles = await tool('ideviceinfo', ['-u', udid, '-k', 'CarrierBundleInfoArray']);
  const entries = [];
  let entry = null;
  for (const line of (bundles.out || '').split('\n')) {
    const start = line.match(/^(\d+):\s*(.*)$/);
    if (start) {
      entry = {};
      entries.push(entry);
    }
    const field = (start ? start[2] : line.trim()).match(/^(\w+): (.*)$/);
    if (entry && field) entry[field[1]] = field[2];
  }
  if (!entries.length && top.IntegratedCircuitCardIdentity && !/NotInserted/i.test(top.SIMTrayStatus || '')) {
    entries.push({
      IntegratedCircuitCardIdentity: top.IntegratedCircuitCardIdentity,
      MCC: top.MobileSubscriberCountryCode,
      MNC: top.MobileSubscriberNetworkCode,
      Slot: 'kOne',
    });
  }

  phone.slots = entries
    .filter((sim) => sim.IntegratedCircuitCardIdentity)
    .map((sim) => {
      const iccid = sim.IntegratedCircuitCardIdentity;
      const carrier = carriersByNetwork[`${sim.MCC}${sim.MNC}`] || (sim.MCC ? `${sim.MCC}-${sim.MNC}` : null);
      return {
        slot: sim.Slot === 'kTwo' ? 2 : 1,
        simKey: iccidKey(iccid),
        simLabel: [carrier, `…${iccid.slice(-4)}`].filter(Boolean).join(' '),
        carrier,
        // The iPhone reports one number; it is only unambiguous when there is a single SIM.
        phoneNumber: entries.length === 1 ? top.PhoneNumber || null : null,
      };
    });
  return phone;
}

export async function readIphones() {
  const list = await tool('idevice_id', ['-l']);
  if (!list.ok) return { phones: [], warning: list.out };
  const phones = [];
  for (const udid of list.out.split('\n').map((row) => row.trim()).filter(Boolean)) {
    phones.push(await readIphone(udid));
  }
  return { phones };
}

export async function readPhones() {
  const [android, ios] = await Promise.all([readAndroidPhones(), readIphones()]);
  return {
    phones: [...android.phones, ...ios.phones],
    warnings: [android.warning, ios.warning].filter(Boolean),
  };
}
