// SIM monitoring agent: every 30 seconds, reads the phones plugged into this Mac and reports them
// to the dashboard. Configure with environment variables:
//   SIM_AGENT_TOKEN   agent key created on the dashboard's Users page (required unless --dry-run)
//   SIM_AGENT_URL     dashboard address (default https://sim-monitoring.bewen.me)
//   SIM_AGENT_INTERVAL_SECONDS  seconds between reports (default 30)
// Usage: node sim-agent.js [--once] [--dry-run]
//   --once     send one report and exit
//   --dry-run  print what would be sent instead of sending it
import { readPhones } from './phone-reader.js';

const url = (process.env.SIM_AGENT_URL || 'https://sim-monitoring.bewen.me').replace(/\/+$/, '');
const token = process.env.SIM_AGENT_TOKEN;
const intervalMs = Math.max(10, Number(process.env.SIM_AGENT_INTERVAL_SECONDS) || 30) * 1000;
const once = process.argv.includes('--once');
const dryRun = process.argv.includes('--dry-run');

if (!token && !dryRun) {
  console.error('SIM_AGENT_TOKEN is required. Create an agent key on the dashboard\'s Users page.');
  process.exit(1);
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

function summarize(phones) {
  if (!phones.length) return 'no phones connected';
  return phones.map((phone) => {
    const name = `${phone.platform === 'ios' ? 'iPhone' : 'Android'} ${phone.model || phone.hardwareId}`;
    if (phone.problem) return `${name}: ${phone.problem}`;
    const sims = phone.slots.map((sim) => `slot ${sim.slot} ${sim.simLabel || 'SIM'}`).join(', ');
    return `${name}: ${sims || 'no SIM'}`;
  }).join('; ');
}

let lastSummary = '';
let lastError = '';

async function reportOnce() {
  const { phones, warnings } = await readPhones();
  if (dryRun) {
    console.log(JSON.stringify({ phones, warnings }, null, 2));
    return;
  }
  const response = await fetch(`${url}/api/agent/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ phones }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Dashboard returned ${response.status}`);
  }
  // Log only when something changes, so the log stays small.
  const summary = [summarize(phones), ...warnings].join(' | ');
  if (summary !== lastSummary || lastError) log(`Reported: ${summary}`);
  lastSummary = summary;
  lastError = '';
}

async function loop() {
  try {
    await reportOnce();
  } catch (error) {
    if (error.message !== lastError) log(`Report failed: ${error.message}`);
    lastError = error.message;
    if (once) process.exitCode = 1;
  }
  if (!once && !dryRun) setTimeout(loop, intervalMs);
}

log(dryRun ? 'Dry run: reading phones without sending.' : `Reporting to ${url} every ${intervalMs / 1000}s.`);
loop();
