// Read-only check of what SIM details this computer can see on USB-connected phones.
// It changes nothing on the phones and sends nothing over the network.
// Usage: node scripts/sim-probe.js [--full]
//   --full  show complete SIM serial numbers (ICCID/IMSI) instead of only the last 4 digits
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const showFull = process.argv.includes('--full');

async function tool(command, args) {
  try {
    const { stdout } = await run(command, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: stdout };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, out: `${error.stdout || ''}${error.stderr || ''}`.trim() || error.message };
  }
}

function mask(value) {
  if (!value || showFull) return value || '';
  const text = String(value);
  return text.length <= 4 ? text : `${'•'.repeat(text.length - 4)}${text.slice(-4)}`;
}

function line(label, value) {
  console.log(`    ${label.padEnd(22)} ${value === undefined || value === '' ? '—' : value}`);
}

function installHint(name) {
  const mac = { adb: 'brew install android-platform-tools', idevice: 'brew install libimobiledevice' };
  const win = {
    adb: 'Download "SDK Platform-Tools for Windows" from developer.android.com and add the folder to PATH',
    idevice: 'Install Apple Devices (or iTunes) plus a libimobiledevice Windows build, and add it to PATH',
  };
  return (process.platform === 'win32' ? win : mac)[name];
}

async function probeAndroid() {
  console.log('\n=== Android phones (adb) ===');
  const list = await tool('adb', ['devices', '-l']);
  if (list.missing) {
    console.log(`  adb is not installed. ${installHint('adb')}`);
    return;
  }
  if (!list.ok) {
    console.log(`  adb failed: ${list.out}`);
    return;
  }

  const devices = list.out.split('\n').slice(1)
    .map((row) => row.trim().split(/\s+/))
    .filter((parts) => parts[0] && parts[1]);
  if (!devices.length) {
    console.log('  No Android phones found. Plug one in with USB debugging turned on.');
    return;
  }

  for (const [serial, state] of devices) {
    console.log(`\n  Phone ${serial}`);
    if (state === 'unauthorized') {
      console.log('    Not authorized yet: unlock the phone and tap "Allow" on the USB debugging prompt.');
      continue;
    }
    if (state !== 'device') {
      console.log(`    Not ready (state: ${state}).`);
      continue;
    }

    const props = await tool('adb', ['-s', serial, 'shell', 'getprop']);
    const prop = (key) => props.out?.match(new RegExp(`^\\[${key.replace(/\./g, '\\.')}\\]: \\[(.*)\\]$`, 'm'))?.[1];
    line('Model', prop('ro.product.model'));
    line('Android version', `${prop('ro.build.version.release') || '?'} (SDK ${prop('ro.build.version.sdk') || '?'})`);
    const simStates = (prop('gsm.sim.state') || '').split(',');
    const carriers = (prop('gsm.sim.operator.alpha') || '').split(',');
    simStates.forEach((simState, index) => {
      line(`Slot ${index + 1} SIM state`, simState || 'unknown');
      line(`Slot ${index + 1} carrier`, carriers[index]);
    });

    // A SIM identity is what makes same-carrier swaps detectable. The siminfo table gives the full ICCID
    // on older Android; newer versions block it, so fall back to the subscription service dump.
    const simInfo = await tool('adb', ['-s', serial, 'shell', 'content', 'query', '--uri', 'content://telephony/siminfo']);
    const rows = simInfo.ok ? simInfo.out.split('\n').filter((row) => row.startsWith('Row:')) : [];
    if (!rows.length) {
      await probeAndroidSubscriptions(serial);
      continue;
    }
    for (const row of rows) {
      const field = (key) => row.match(new RegExp(`(?:^|, )${key}=([^,]*)`))?.[1];
      const slotIndex = Number(field('sim_id'));
      // Rows with slot -1 are SIMs seen in the past but not currently inserted.
      const where = slotIndex >= 0 ? `slot ${slotIndex + 1}` : 'not inserted';
      line(`SIM (${where})`, `ICCID ${mask(field('icc_id')) || '—'}, carrier ${field('carrier_name') || '—'}, number ${field('number') || '—'}`);
    }
  }
}

// Android gives each physical SIM it has ever seen its own subscription id, keyed by the full ICCID.
// A slot whose id changes therefore holds a different SIM, even from the same carrier.
async function probeAndroidSubscriptions(serial) {
  const dump = await tool('adb', ['-s', serial, 'shell', 'dumpsys', 'isub']);
  const records = new Map();
  for (const row of (dump.out || '').split('\n')) {
    const match = row.match(/SubscriptionInfoInternal: id=(\d+) iccId=(\S*) simSlotIndex=(-?\d+)/);
    if (!match) continue;
    // carrierName can contain spaces, so it runs until the next " key=" pair.
    const carrier = row.match(/ carrierName=(.*?)(?= \w+=|$)/)?.[1];
    records.set(match[1], { iccid: match[2], slot: Number(match[3]), carrier });
  }
  if (!records.size) {
    line('SIM identity', `not readable${dump.ok ? '' : ` (${dump.out.split('\n')[0].slice(0, 100)})`}`);
    return;
  }
  const inserted = [...records.entries()].filter(([, sim]) => sim.slot >= 0).sort((a, b) => a[1].slot - b[1].slot);
  for (const [id, sim] of inserted) {
    line(`Slot ${sim.slot + 1} SIM`, `SIM #${id} (ICCID starts ${sim.iccid.replace(/\[\*+\]$/, '…')}), carrier ${sim.carrier}`);
  }
  const past = [...records.keys()].filter((id) => records.get(id).slot < 0);
  line('Previously seen SIMs', past.length ? past.map((id) => `#${id}`).join(', ') : 'none');
}

async function probeIphone() {
  console.log('\n=== iPhones (libimobiledevice) ===');
  const list = await tool('idevice_id', ['-l']);
  if (list.missing) {
    console.log(`  libimobiledevice is not installed. ${installHint('idevice')}`);
    return;
  }
  const udids = list.ok ? list.out.split('\n').map((row) => row.trim()).filter(Boolean) : [];
  if (!udids.length) {
    console.log('  No iPhones found. Plug one in, unlock it and tap "Trust This Computer".');
    return;
  }

  for (const udid of udids) {
    console.log(`\n  iPhone ${mask(udid)}`);
    const info = await tool('ideviceinfo', ['-u', udid]);
    if (!info.ok) {
      console.log('    Could not read it. Unlock the iPhone and tap "Trust This Computer", then run this again.');
      console.log(`    (${info.out.split('\n')[0].slice(0, 120)})`);
      continue;
    }
    const value = (key) => info.out.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1];
    line('Model', `${value('DeviceName') || '?'} (${value('ProductType') || '?'})`);
    line('iOS version', value('ProductVersion'));
    line('SIM status', value('SIMStatus'));
    line('SIM tray', value('SIMTrayStatus'));
    line('SIM serial (ICCID)', mask(value('IntegratedCircuitCardIdentity')) || 'not readable');
    line('Subscriber ID (IMSI)', mask(value('InternationalMobileSubscriberIdentity')) || 'not readable');
    line('Phone number', value('PhoneNumber'));
  }
}

console.log('SIM probe: read-only check of what this computer can see. Nothing is changed or sent anywhere.');
await probeAndroid();
await probeIphone();
console.log('\nShare this output (it hides all but the last 4 digits of SIM serials) to decide what the monitor can detect.');
