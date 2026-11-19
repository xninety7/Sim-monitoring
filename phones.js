// Monitored phones and Mac agents, shown under the inventory for admins only.
// Uses apiRequest, escapeHtml and showMessage from app.js.
(() => {
const monitoringAdmin = document.getElementById('monitoringAdmin');
const phoneDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function formatDate(value) {
  return value ? escapeHtml(phoneDateFormat.format(new Date(value))) : 'Never';
}

const phonesTableBody = document.getElementById('phonesTableBody');
const phonesCount = document.getElementById('phonesCount');
const agentsTableBody = document.getElementById('agentsTableBody');
const agentsCount = document.getElementById('agentsCount');
const addAgentForm = document.getElementById('addAgentForm');
const newAgentKey = document.getElementById('newAgentKey');
const newAgentName = document.getElementById('newAgentName');
const newAgentToken = document.getElementById('newAgentToken');
const copyAgentTokenBtn = document.getElementById('copyAgentTokenBtn');
let allPhones = [];
let allAssets = [];
let allAgents = [];

const simStateLabels = { present: '✓', removed: '⚠ removed', changed: '⚠ changed', empty: 'empty' };

function phoneTitle(phone) {
  const platform = phone.platform === 'ios' ? 'iPhone' : 'Android';
  const model = phone.model || '';
  if (model.toLowerCase().startsWith(platform.toLowerCase())) return `<strong>${escapeHtml(model)}</strong>`;
  return `<strong>${platform}</strong> ${escapeHtml(model)}`;
}

function renderPhones() {
  phonesCount.textContent = `${allPhones.length} phone${allPhones.length === 1 ? '' : 's'}`;
  if (!allPhones.length) {
    phonesTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">No phones reported yet. Install the agent on a Mac and plug a phone in.</td></tr>';
    return;
  }
  // An asset can have only one phone, so offer assets that are free or already this phone's.
  const linkedAssetIds = new Set(allPhones.map((phone) => phone.deviceId).filter(Boolean));
  phonesTableBody.innerHTML = allPhones.map((phone) => {
    const options = allAssets
      .filter((asset) => asset.id === phone.deviceId || !linkedAssetIds.has(asset.id))
      .map((asset) => `<option value="${asset.id}" ${asset.id === phone.deviceId ? 'selected' : ''}>${escapeHtml(asset.deviceName)} · ${escapeHtml(asset.attachedPc)}</option>`)
      .join('');
    const connection = phone.problem && phone.connected ? `<span class="monitor-state monitor-warn">⚠ ${escapeHtml(phone.problem)}</span>`
      : phone.connected ? '<span class="monitor-state monitor-on">● Connected</span>'
        : `<span class="monitor-state monitor-off">○ Offline</span><div class="monitor-detail">Last seen ${formatDate(phone.lastSeenAt)}</div>`;
    const sims = phone.slots.length
      ? phone.slots.map((slot) => `Slot ${slot.slotNumber}: ${escapeHtml(slot.simLabel || slot.expectedSimLabel || '—')} ${simStateLabels[slot.state]}`).join('<br>')
      : '—';
    return `
      <tr>
        <td>${phoneTitle(phone)}<div class="monitor-detail">${escapeHtml(phone.osVersion || '')} · ID …${escapeHtml(phone.hardwareId.slice(-4))}</div></td>
        <td>${escapeHtml(phone.agentName || '—')}</td>
        <td>${connection}</td>
        <td>${sims}</td>
        <td>
          <select class="link-asset-select" data-id="${phone.id}" aria-label="Asset for this phone">
            <option value="">Not linked</option>
            ${options}
          </select>
        </td>
        <td><button class="delete-btn delete-phone-btn" data-id="${phone.id}" type="button">Remove</button></td>
      </tr>
    `;
  }).join('');
}

function renderAgents() {
  agentsCount.textContent = `${allAgents.length} Mac${allAgents.length === 1 ? '' : 's'}`;
  agentsTableBody.innerHTML = allAgents.length
    ? allAgents.map((agent) => `
      <tr>
        <td><strong>${escapeHtml(agent.name)}</strong></td>
        <td>${formatDate(agent.lastReportAt)}</td>
        <td>${agent.connectedPhones}</td>
        <td><button class="delete-btn delete-agent-btn" data-id="${agent.id}" type="button">Revoke key</button></td>
      </tr>
    `).join('')
    : '<tr><td colspan="4" class="empty-state">No Mac agents yet.</td></tr>';
}

async function loadMonitoring() {
  try {
    [allPhones, allAssets, allAgents] = await Promise.all([
      apiRequest('/api/phones'),
      apiRequest('/api/devices'),
      apiRequest('/api/agents'),
    ]);
    renderPhones();
    renderAgents();
  } catch (error) {
    phonesCount.textContent = 'Unavailable';
    agentsCount.textContent = 'Unavailable';
    showMessage(error.message, true);
  }
}

phonesTableBody.addEventListener('change', async (event) => {
  const select = event.target.closest('.link-asset-select');
  if (!select) return;
  try {
    await apiRequest(`/api/phones/${select.dataset.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ deviceId: select.value ? Number(select.value) : null }),
    });
    showMessage(select.value ? 'Phone linked to the asset.' : 'Phone unlinked.');
  } catch (error) {
    showMessage(error.message, true);
  }
  await loadMonitoring();
});

phonesTableBody.addEventListener('click', async (event) => {
  const button = event.target.closest('.delete-phone-btn');
  if (!button) return;
  if (!window.confirm('Remove this phone and its SIM history? If it is still plugged in, it will reappear as a new phone.')) return;
  try {
    await apiRequest(`/api/phones/${button.dataset.id}`, { method: 'DELETE' });
    showMessage('Phone removed.');
    await loadMonitoring();
  } catch (error) {
    showMessage(error.message, true);
  }
});

agentsTableBody.addEventListener('click', async (event) => {
  const button = event.target.closest('.delete-agent-btn');
  if (!button) return;
  const agent = allAgents.find((item) => item.id === Number(button.dataset.id));
  if (!agent || !window.confirm(`Revoke the agent key for ${agent.name}? That Mac will stop reporting until it gets a new key.`)) return;
  try {
    await apiRequest(`/api/agents/${agent.id}`, { method: 'DELETE' });
    showMessage(`Revoked the agent key for ${agent.name}.`);
    await loadMonitoring();
  } catch (error) {
    showMessage(error.message, true);
  }
});

addAgentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = String(new FormData(addAgentForm).get('name') || '').trim();
  try {
    const agent = await apiRequest('/api/agents', { method: 'POST', body: JSON.stringify({ name }) });
    addAgentForm.reset();
    newAgentName.textContent = agent.name;
    newAgentToken.textContent = agent.token;
    newAgentKey.hidden = false;
    showMessage('');
    await loadMonitoring();
  } catch (error) {
    showMessage(error.message, true);
  }
});

copyAgentTokenBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(newAgentToken.textContent);
    copyAgentTokenBtn.textContent = 'Copied';
  } catch {
    window.getSelection().selectAllChildren(newAgentToken);
  }
});

window.addEventListener('live-change', () => {
  if (!monitoringAdmin.hidden) loadMonitoring();
});

apiRequest('/api/me').then((me) => {
  if (!me?.isAdmin) return;
  monitoringAdmin.hidden = false;
  loadMonitoring();
}).catch(() => {});
})();
