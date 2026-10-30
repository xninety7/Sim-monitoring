let allDevices = [];

const searchInput = document.getElementById('searchInput');
const statusFilter = document.getElementById('statusFilter');
const tableBody = document.getElementById('deviceTableBody');
const resultsCount = document.getElementById('resultsCount');
const pagination = document.getElementById('pagination');
const previousPageBtn = document.getElementById('previousPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageInfo = document.getElementById('pageInfo');
const pageSize = 10;
let currentPage = 1;
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
const switchSourceSlotInput = document.getElementById('switchSourceSlotInput');
const switchTargetSlotInput = document.getElementById('switchTargetSlotInput');
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
    tableBody.innerHTML = '<tr><td colspan="10" class="empty-state">Connect to the configured PostgreSQL database to load devices.</td></tr>';
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
      ...(device.sims || []).flatMap((sim) => [sim.simNumber, sim.iccid, sim.imei]),
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
        <td colspan="10" class="empty-state">No matching devices found.</td>
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
        <td class="sim-assignment-cell">${renderSimAssignments(device)}</td>
        <td>
          <span class="status-pill status-${escapeHtml(device.status)}">${escapeHtml(device.status)}</span>
        </td>
        <td>${escapeHtml(device.lastSeen || '—')}</td>
        <td>
          <button class="switch-btn" data-id="${device.id}" type="button" ${hasSimAssignments(device) ? '' : 'disabled'}>Switch SIM</button>
          <button class="edit-btn" data-id="${device.id}" type="button">Edit</button>
          <button class="delete-btn" data-id="${device.id}" type="button">Delete</button>
        </td>
      </tr>
    `)
    .join('');
}

function renderSimAssignments(device) {
  return Array.from({ length: device.simSlotCount || 1 }, (_, index) => {
    const slotNumber = index + 1;
    const sim = device.sims?.find((assignment) => assignment.slotNumber === slotNumber);
    const identifier = sim?.simNumber || sim?.iccid || sim?.imei || 'Empty';
    return `<span><strong>Slot ${slotNumber}:</strong> ${escapeHtml(identifier)}</span>`;
  }).join('<br>');
}

function hasSimAssignments(device) {
  return Boolean(device.sims?.some((sim) => sim.simNumber || sim.iccid || sim.imei));
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

function setSimSlotVisibility(form, slotCount) {
  const secondSlot = form.querySelector('[data-sim-slot="2"]');
  secondSlot.hidden = Number(slotCount) < 2;
}

function readSimSlots(formData, slotCount) {
  return Array.from({ length: slotCount }, (_, index) => {
    const slotNumber = index + 1;
    const sim = {
      slotNumber,
      simNumber: String(formData.get(`sim${slotNumber}Number`) || '').trim(),
      iccid: String(formData.get(`sim${slotNumber}Iccid`) || '').trim(),
      imei: String(formData.get(`sim${slotNumber}Imei`) || '').trim(),
    };
    return sim.simNumber || sim.iccid || sim.imei ? sim : null;
  }).filter(Boolean);
}

for (const form of [deviceForm, editDeviceForm]) {
  form.elements.simSlotCount.addEventListener('change', () => {
    const nextSlotCount = Number(form.elements.simSlotCount.value);
    const currentAsset = allDevices.find((device) => device.id === editDeviceId);
    if (form === editDeviceForm && nextSlotCount === 1 && currentAsset?.sims.some((sim) => sim.slotNumber === 2)) {
      form.elements.simSlotCount.value = '2';
      showMessage('Move or remove the SIM in slot 2 before changing this asset to single SIM.', true);
      return;
    }
    setSimSlotVisibility(form, nextSlotCount);
  });
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
    simSlotCount: Number(formData.get('simSlotCount')),
    sims: readSimSlots(formData, Number(formData.get('simSlotCount'))),
    status: String(formData.get('status')) || 'active',
    lastSeen: '',
  };

  try {
    await apiRequest('/api/devices', { method: 'POST', body: JSON.stringify(newDevice) });
    deviceForm.reset();
    setSimSlotVisibility(deviceForm, 1);
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
  for (const field of ['deviceName', 'attachedPc', 'phoneNumber', 'anydeskId', 'color', 'telcoProvider', 'simSlotCount', 'status', 'lastSeen']) {
    editDeviceForm.elements[field].value = device[field] || (field === 'status' ? 'active' : '');
  }
  for (const slotNumber of [1, 2]) {
    const sim = device.sims?.find((assignment) => assignment.slotNumber === slotNumber);
    editDeviceForm.elements[`sim${slotNumber}Number`].value = sim?.simNumber || '';
    editDeviceForm.elements[`sim${slotNumber}Iccid`].value = sim?.iccid || '';
    editDeviceForm.elements[`sim${slotNumber}Imei`].value = sim?.imei || '';
  }
  setSimSlotVisibility(editDeviceForm, device.simSlotCount || 1);
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
  updates.simSlotCount = Number(formData.get('simSlotCount'));
  updates.sims = readSimSlots(formData, updates.simSlotCount);

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

  const assignedSlots = (source.sims || []).filter((sim) => sim.simNumber || sim.iccid || sim.imei);
  if (!assignedSlots.length) {
    showMessage('Add a SIM to one of this asset’s slots before switching it.', true);
    return;
  }

  switchSourceId = sourceId;
  switchSourceLabel.textContent = `Choose which assigned SIM to move from ${source.deviceName} (${source.attachedPc}).`;
  switchSourceSlotInput.innerHTML = assignedSlots.map((sim) => {
    const identifier = sim.simNumber || sim.iccid || sim.imei;
    return `<option value="${sim.slotNumber}">Slot ${sim.slotNumber} · ${escapeHtml(identifier)}</option>`;
  }).join('');

  const destinations = allDevices.filter((device) => device.id !== sourceId);
  switchTargetInput.innerHTML = destinations.map((device) => {
    const label = `${device.deviceName} · ${device.attachedPc} · ${device.simSlotCount} SIM slot${device.simSlotCount === 1 ? '' : 's'}`;
    return `<option value="${device.id}">${escapeHtml(label)}</option>`;
  }).join('');
  switchTargetInput.disabled = !destinations.length;
  switchTargetSlotInput.disabled = !destinations.length;
  confirmSwitchBtn.disabled = !destinations.length;
  updateSwitchDestinationSlots(true);

  switchSimDialog.showModal();
}

function updateSwitchDestinationSlots(refreshSlots = false) {
  const target = allDevices.find((device) => device.id === Number(switchTargetInput.value));
  if (!target) {
    switchTargetSlotInput.innerHTML = '<option value="">No destination asset available</option>';
    switchNote.textContent = 'Add another asset before moving a SIM.';
    confirmSwitchBtn.disabled = true;
    return;
  }

  if (refreshSlots) {
    switchTargetSlotInput.innerHTML = Array.from({ length: target.simSlotCount || 1 }, (_, index) => {
      const slotNumber = index + 1;
      const assigned = target.sims?.find((sim) => sim.slotNumber === slotNumber && (sim.simNumber || sim.iccid || sim.imei));
      const identifier = assigned ? ` — occupied by ${escapeHtml(assigned.simNumber || assigned.iccid || assigned.imei)}` : ' — empty';
      return `<option value="${slotNumber}">Slot ${slotNumber}${identifier}</option>`;
    }).join('');
  }

  const selectedSlot = target.sims?.find((sim) => sim.slotNumber === Number(switchTargetSlotInput.value));
  if (selectedSlot?.simNumber || selectedSlot?.iccid || selectedSlot?.imei) {
    switchNote.textContent = 'This destination slot is occupied. Confirming will swap the two SIM assignments.';
  } else {
    switchNote.textContent = 'This destination slot is empty. The selected SIM will move there.';
  }
  confirmSwitchBtn.disabled = false;
}

switchTargetInput.addEventListener('change', () => updateSwitchDestinationSlots(true));
switchTargetSlotInput.addEventListener('change', () => updateSwitchDestinationSlots());

cancelSwitchBtn.addEventListener('click', () => switchSimDialog.close());

switchSimForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const target = allDevices.find((device) => device.id === Number(switchTargetInput.value));
  const source = allDevices.find((device) => device.id === switchSourceId);
  if (!source || !target) return;

  try {
    const sourceSlot = Number(switchSourceSlotInput.value);
    const targetSlot = Number(switchTargetSlotInput.value);
    const targetOccupied = target.sims?.some((sim) => sim.slotNumber === targetSlot && (sim.simNumber || sim.iccid || sim.imei));
    await apiRequest(`/api/devices/${source.id}/switch-sim`, {
      method: 'POST',
      body: JSON.stringify({ targetId: target.id, sourceSlot, targetSlot }),
    });
    switchSimDialog.close();
    await loadDevices();
    showMessage(`SIM ${targetOccupied ? 'swapped' : 'moved'} from ${source.deviceName} slot ${sourceSlot} to ${target.deviceName} slot ${targetSlot}.`);
  } catch (error) {
    showMessage(error.message, true);
  }
});

loadDevices();
