let allDevices = [];

const searchInput = document.getElementById('searchInput');
const statusFilter = document.getElementById('statusFilter');
const tableBody = document.getElementById('deviceTableBody');
const resultsCount = document.getElementById('resultsCount');
const activityList = document.getElementById('activityList');
const activityPanel = document.getElementById('activityPanel');
const activityCount = document.getElementById('activityCount');
const activityPagination = document.getElementById('activityPagination');
const activityPreviousBtn = document.getElementById('activityPreviousBtn');
const activityNextBtn = document.getElementById('activityNextBtn');
const activityPageInfo = document.getElementById('activityPageInfo');
const toggleActivityBtn = document.getElementById('toggleActivityBtn');
const pagination = document.getElementById('pagination');
const previousPageBtn = document.getElementById('previousPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageInfo = document.getElementById('pageInfo');
const pageSize = 10;
let currentPage = 1;
let activityPage = 1;
let activityPageCount = 1;
const deviceForm = document.getElementById('deviceForm');
const addDeviceDialog = document.getElementById('addDeviceDialog');
const cancelAddDeviceBtn = document.getElementById('cancelAddDeviceBtn');
const toggleDeviceFormBtn = document.getElementById('toggleDeviceFormBtn');
const editDeviceDialog = document.getElementById('editDeviceDialog');
const editDeviceForm = document.getElementById('editDeviceForm');
const cancelEditDeviceBtn = document.getElementById('cancelEditDeviceBtn');
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
let editDeviceId = null;

const countEls = {
  total: document.getElementById('totalPhones'),
  active: document.getElementById('activeCount'),
  inactive: document.getElementById('inactiveCount'),
  offline: document.getElementById('offlineCount'),
};

const appMessage = document.getElementById('appMessage');
const importLocalBtn = document.getElementById('importLocalBtn');

toggleDeviceFormBtn.addEventListener('click', () => addDeviceDialog.showModal());
cancelAddDeviceBtn.addEventListener('click', () => addDeviceDialog.close());
toggleActivityBtn.addEventListener('click', async () => {
  const isExpanded = toggleActivityBtn.getAttribute('aria-expanded') === 'true';
  toggleActivityBtn.setAttribute('aria-expanded', String(!isExpanded));
  activityPanel.hidden = isExpanded;
  if (!isExpanded) {
    activityPage = 1;
    await loadActivity();
  }
});

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
    if (!activityPanel.hidden) await loadActivity(activityPage);
    const hasLocalRecords = Boolean(localStorage.getItem('sim-monitoring-devices'));
    importLocalBtn.hidden = allDevices.length > 0 || !hasLocalRecords;
    if (importLocalBtn.hidden) showMessage('');
    else showMessage('The shared database is empty. You can import this browser’s saved devices once.');
  } catch (error) {
    importLocalBtn.hidden = true;
    showMessage(`Could not load shared devices: ${error.message}`, true);
    resultsCount.textContent = 'Database unavailable';
    tableBody.innerHTML = '<tr><td colspan="9" class="empty-state">Connect to the configured PostgreSQL database to load devices.</td></tr>';
  }
}

async function loadActivity(page = 1) {
  try {
    const result = await apiRequest(`/api/activity?page=${page}`);
    activityPage = result.page;
    activityPageCount = result.pageCount;
    activityCount.textContent = `${result.total} action${result.total === 1 ? '' : 's'}`;
    activityPageInfo.textContent = `Page ${activityPage} of ${activityPageCount}`;
    activityPagination.hidden = activityPageCount <= 1;
    activityPreviousBtn.disabled = activityPage <= 1;
    activityNextBtn.disabled = activityPage >= activityPageCount;
    activityList.innerHTML = result.events.length
      ? result.events.map((event) => `
          <li class="activity-item">
            <div class="activity-summary">
              <strong>${escapeHtml(event.actor)}</strong>
              <span>${escapeHtml(event.action)}</span>
              <span>${escapeHtml(event.details)}</span>
            </div>
            <time datetime="${escapeHtml(event.createdAt)}">${escapeHtml(new Date(event.createdAt).toLocaleString())}</time>
          </li>
        `).join('')
      : '<li class="activity-empty">No activity recorded yet.</li>';
  } catch {
    activityList.innerHTML = '<li class="activity-empty">Activity log is unavailable.</li>';
    activityPagination.hidden = true;
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
      device.telcoProvider,
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
  const pageCount = Math.ceil(filtered.length / pageSize);
  currentPage = Math.min(currentPage, Math.max(pageCount, 1));
  resultsCount.textContent = `${filtered.length} records`;
  renderSummary(filtered);

  pagination.hidden = pageCount <= 1;
  pageInfo.textContent = `Page ${currentPage} of ${Math.max(pageCount, 1)}`;
  previousPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= pageCount;

  if (!filtered.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="9" class="empty-state">No matching devices found.</td>
      </tr>
    `;
    return;
  }

  const pageDevices = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  tableBody.innerHTML = pageDevices
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
        <td>${escapeHtml(device.anydeskId || '—')}</td>
        <td>${escapeHtml(device.color || '—')}</td>
        <td>${escapeHtml(device.telcoProvider || '—')}</td>
        <td>
          <span class="status-pill status-${escapeHtml(device.status)}">${escapeHtml(device.status)}</span>
        </td>
        <td>${escapeHtml(device.lastSeen || '—')}</td>
        <td>
          <button class="switch-btn" data-id="${device.id}" type="button">Switch SIM</button>
          <button class="edit-btn" data-id="${device.id}" type="button">Edit</button>
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

searchInput.addEventListener('input', () => {
  currentPage = 1;
  renderTable();
});
statusFilter.addEventListener('change', () => {
  currentPage = 1;
  renderTable();
});

previousPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage -= 1;
    renderTable();
  }
});

nextPageBtn.addEventListener('click', () => {
  const pageCount = Math.ceil(getFilteredDevices().length / pageSize);
  if (currentPage < pageCount) {
    currentPage += 1;
    renderTable();
  }
});

activityPreviousBtn.addEventListener('click', () => {
  if (activityPage > 1) loadActivity(activityPage - 1);
});

activityNextBtn.addEventListener('click', () => {
  if (activityPage < activityPageCount) loadActivity(activityPage + 1);
});

deviceForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(deviceForm);
  const newDevice = {
    deviceName: String(formData.get('deviceName')).trim(),
    attachedPc: String(formData.get('attachedPc')).trim(),
    phoneNumber: String(formData.get('phoneNumber')).trim(),
    anydeskId: String(formData.get('anydeskId') || '').trim(),
    color: String(formData.get('color') || '').trim(),
    telcoProvider: String(formData.get('telcoProvider') || '').trim(),
    status: String(formData.get('status')) || 'active',
    lastSeen: '',
  };

  try {
    await apiRequest('/api/devices', { method: 'POST', body: JSON.stringify(newDevice) });
    deviceForm.reset();
    addDeviceDialog.close();
    await loadDevices();
    showMessage('Asset added to the shared inventory.');
  } catch (error) {
    showMessage(error.message, true);
  }
});

tableBody.addEventListener('click', async (event) => {
  const editButton = event.target.closest('.edit-btn');
  if (editButton) {
    openEditDialog(Number(editButton.dataset.id));
    return;
  }

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
    showMessage('Asset deleted from the shared inventory.');
  } catch (error) {
    showMessage(error.message, true);
  }
});

function openEditDialog(deviceId) {
  const device = allDevices.find((item) => item.id === deviceId);
  if (!device) return;

  editDeviceId = deviceId;
  for (const field of ['deviceName', 'attachedPc', 'phoneNumber', 'anydeskId', 'color', 'telcoProvider', 'status', 'lastSeen']) {
    editDeviceForm.elements[field].value = device[field] || (field === 'status' ? 'active' : '');
  }
  editDeviceDialog.showModal();
}

cancelEditDeviceBtn.addEventListener('click', () => editDeviceDialog.close());

editDeviceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (editDeviceId === null) return;

  const formData = new FormData(editDeviceForm);
  const updates = Object.fromEntries(
    ['deviceName', 'attachedPc', 'phoneNumber', 'anydeskId', 'color', 'telcoProvider', 'status', 'lastSeen']
      .map((field) => [field, String(formData.get(field) || '').trim()]),
  );

  try {
    await apiRequest(`/api/devices/${editDeviceId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    editDeviceDialog.close();
    editDeviceId = null;
    await loadDevices();
    showMessage('Asset updated in the shared inventory.');
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

loadDevices();
