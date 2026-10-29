let allDevices = [];

const searchInput = document.getElementById('searchInput');
const statusFilter = document.getElementById('statusFilter');
const tableBody = document.getElementById('deviceTableBody');
const resultsCount = document.getElementById('resultsCount');
const deviceForm = document.getElementById('deviceForm');
const switchSimDialog = document.getElementById('switchSimDialog');
const switchSimForm = document.getElementById('switchSimForm');
const switchTargetInput = document.getElementById('switchTargetInput');
const switchSourceLabel = document.getElementById('switchSourceLabel');
const switchSimIdField = document.getElementById('switchSimIdField');
const switchSimIdInput = document.getElementById('switchSimIdInput');
const switchNote = document.getElementById('switchNote');
const confirmSwitchBtn = document.getElementById('confirmSwitchBtn');
const cancelSwitchBtn = document.getElementById('cancelSwitchBtn');
let switchSourceId = null;

const countEls = {
  total: document.getElementById('totalPhones'),
  active: document.getElementById('activeCount'),
  inactive: document.getElementById('inactiveCount'),
  offline: document.getElementById('offlineCount'),
};

const appMessage = document.getElementById('appMessage');
const importLocalBtn = document.getElementById('importLocalBtn');

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? null : response.json();
}

function showMessage(message, isError = false) {
  appMessage.textContent = message;
  appMessage.hidden = !message;
  appMessage.classList.toggle('error', isError);
}

async function loadDevices() {
  try {
    allDevices = await apiRequest('/api/devices');
    renderTable();
    const hasLocalRecords = Boolean(localStorage.getItem('sim-monitoring-devices'));
    importLocalBtn.hidden = allDevices.length > 0 || !hasLocalRecords;
    if (importLocalBtn.hidden) showMessage('');
    else showMessage('The shared database is empty. You can import this browser’s saved devices once.');
  } catch (error) {
    importLocalBtn.hidden = true;
    showMessage(`Could not load shared devices: ${error.message}`, true);
    resultsCount.textContent = 'Database unavailable';
    tableBody.innerHTML = '<tr><td colspan="8" class="empty-state">Connect to the configured PostgreSQL database to load devices.</td></tr>';
  }
}

importLocalBtn.addEventListener('click', async () => {
  try {
    const saved = JSON.parse(localStorage.getItem('sim-monitoring-devices') || '[]');
    if (!Array.isArray(saved) || !saved.length) throw new Error('No saved device records found in this browser.');
    const result = await apiRequest('/api/devices/import', {
      method: 'POST',
      body: JSON.stringify({ devices: saved }),
    });
    importLocalBtn.hidden = true;
    await loadDevices();
    showMessage(`Imported ${result.imported} devices into the shared database.`);
  } catch (error) {
    showMessage(error.message, true);
  }
});

function renderSummary(items) {
  const summary = {
    total: items.length,
    active: items.filter((item) => item.status === 'active').length,
    inactive: items.filter((item) => item.status === 'inactive').length,
    offline: items.filter((item) => item.status === 'offline').length,
  };

  countEls.total.textContent = summary.total;
  countEls.active.textContent = summary.active;
  countEls.inactive.textContent = summary.inactive;
  countEls.offline.textContent = summary.offline;
}

function getFilteredDevices() {
  const q = searchInput.value.trim().toLowerCase();
  const selectedStatus = statusFilter.value;

  return allDevices.filter((device) => {
    const matchSearch = !q || [
      device.deviceName,
      device.attachedPc,
      device.phoneNumber,
      device.anydeskId,
      device.color,
      device.simNumber,
      device.iccid,
      device.imei,
    ].some((value) => String(value || '').toLowerCase().includes(q));

    const matchStatus = selectedStatus === 'all' || device.status === selectedStatus;
    return matchSearch && matchStatus;
  });
}

function renderTable() {
  const filtered = getFilteredDevices();
  resultsCount.textContent = `${filtered.length} records`;
  renderSummary(filtered);

  if (!filtered.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state">No matching devices found.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = filtered
    .map((device) => `
      <tr>
        <td>
          <div class="device-cell">
            <div>
              <div class="device-name">${escapeHtml(device.deviceName)}</div>
            </div>
          </div>
        </td>
        <td>${escapeHtml(device.attachedPc)}</td>
        <td>${escapeHtml(device.phoneNumber)}</td>
        <td>
          <input class="device-text-input" data-field="anydeskId" data-id="${device.id}" type="text" value="${escapeHtml(device.anydeskId || '')}" aria-label="AnyDesk ID for ${escapeHtml(device.deviceName)}" placeholder="Not set" />
        </td>
        <td>
          <input class="device-text-input" data-field="color" data-id="${device.id}" type="text" value="${escapeHtml(device.color || '')}" aria-label="Color for ${escapeHtml(device.deviceName)}" placeholder="Not set" />
        </td>
        <td>
          <span class="status-pill status-${escapeHtml(device.status)}">${escapeHtml(device.status)}</span>
        </td>
        <td>
          <input class="last-seen-input" data-id="${device.id}" type="text" value="${escapeHtml(device.lastSeen)}" aria-label="Last seen for ${escapeHtml(device.deviceName)}" />
        </td>
        <td>
          <button class="switch-btn" data-id="${device.id}" type="button">Switch SIM</button>
          <button class="delete-btn" data-id="${device.id}" type="button">Delete</button>
        </td>
      </tr>
    `)
    .join('');
}

function hasSimAssignment(device) {
  return Boolean(device.simNumber || device.iccid || device.imei);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

searchInput.addEventListener('input', renderTable);
statusFilter.addEventListener('change', renderTable);

deviceForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(deviceForm);
  const newDevice = {
    deviceName: String(formData.get('deviceName')).trim(),
    attachedPc: String(formData.get('attachedPc')).trim(),
    phoneNumber: String(formData.get('phoneNumber')).trim(),
    anydeskId: String(formData.get('anydeskId') || '').trim(),
    color: String(formData.get('color') || '').trim(),
    status: String(formData.get('status')) || 'active',
    lastSeen: '',
  };

  try {
    await apiRequest('/api/devices', { method: 'POST', body: JSON.stringify(newDevice) });
    deviceForm.reset();
    await loadDevices();
    showMessage('Device added to the shared inventory.');
  } catch (error) {
    showMessage(error.message, true);
  }
});

tableBody.addEventListener('click', async (event) => {
  const switchButton = event.target.closest('.switch-btn');
  if (switchButton) {
    openSwitchDialog(Number(switchButton.dataset.id));
    return;
  }

  const button = event.target.closest('.delete-btn');
  if (!button) return;

  try {
    await apiRequest(`/api/devices/${button.dataset.id}`, { method: 'DELETE' });
    await loadDevices();
    showMessage('Device deleted from the shared inventory.');
  } catch (error) {
    showMessage(error.message, true);
  }
});

function openSwitchDialog(sourceId) {
  const source = allDevices.find((device) => device.id === sourceId);
  if (!source) return;

  switchSourceId = sourceId;
  const sourceHasAssignment = hasSimAssignment(source);
  switchSourceLabel.textContent = sourceHasAssignment
    ? `SIM currently assigned to ${source.deviceName} (${source.attachedPc}).`
    : `${source.deviceName} (${source.attachedPc}) has no SIM recorded yet.`;
  switchSimIdField.hidden = sourceHasAssignment;
  switchSimIdInput.required = !sourceHasAssignment;
  switchSimIdInput.value = '';

  const destinations = allDevices.filter((device) =>
    device.id !== sourceId && (sourceHasAssignment || !hasSimAssignment(device))
  );
  switchTargetInput.innerHTML = allDevices
    .filter((device) => destinations.some((destination) => destination.id === device.id))
    .map((device) => {
      const assignmentLabel = hasSimAssignment(device) ? 'SIM assigned — will swap' : 'No SIM — available';
      const label = `${device.deviceName} · ${device.attachedPc} · ${device.status} · ${assignmentLabel}`;
      return `<option value="${device.id}">${escapeHtml(label)}</option>`;
    })
    .join('');
  if (!destinations.length) {
    switchTargetInput.innerHTML = '<option value="">No phone without an assigned SIM</option>';
  }

  switchNote.textContent = sourceHasAssignment
    ? 'If the destination already has a SIM, the assignments will swap. Otherwise, this SIM will move to the destination phone.'
    : 'Enter the SIM identifier to assign it to an available phone. The source phone will remain unassigned.';
  confirmSwitchBtn.disabled = !destinations.length;

  switchSimDialog.showModal();
}

cancelSwitchBtn.addEventListener('click', () => switchSimDialog.close());

switchSimForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const source = allDevices.find((device) => device.id === switchSourceId);
  const target = allDevices.find((device) => device.id === Number(switchTargetInput.value));
  if (!source || !target) return;

  try {
    const payload = { targetId: target.id };
    if (!hasSimAssignment(source)) payload.simNumber = switchSimIdInput.value.trim();
    await apiRequest(`/api/devices/${source.id}/switch-sim`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    switchSimDialog.close();
    await loadDevices();
    showMessage(`SIM assignment updated for ${source.deviceName} and ${target.deviceName}.`);
  } catch (error) {
    showMessage(error.message, true);
  }
});

tableBody.addEventListener('change', async (event) => {
  const input = event.target.closest('.last-seen-input, .device-text-input');
  if (!input) return;

  const device = allDevices.find((item) => item.id === Number(input.dataset.id));
  if (!device) return;

  const field = input.dataset.field || 'lastSeen';

  try {
    const updated = await apiRequest(`/api/devices/${device.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: input.value.trim() }),
    });
    Object.assign(device, updated);
    const fieldLabel = { anydeskId: 'AnyDesk ID', color: 'Color', lastSeen: 'Last Seen' }[field];
    showMessage(`${fieldLabel} saved to the shared database.`);
  } catch (error) {
    input.value = device[field] || '';
    showMessage(error.message, true);
  }
});

loadDevices();
