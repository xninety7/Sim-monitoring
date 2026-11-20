// Dashboard: the phones the Mac agents can see, and the state of each SIM slot.
// Everyone can view and accept SIM changes; only admins can link phones to assets or remove them.
const appMessage = document.getElementById('appMessage');
const phonesTableBody = document.getElementById('phonesTableBody');
const phonesCount = document.getElementById('phonesCount');
const phoneDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let allPhones = [];
let allAssets = [];
let isAdmin = false;

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401) window.location.replace('/login.html');
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function formatDate(value) {
  return value ? escapeHtml(phoneDateFormat.format(new Date(value))) : 'Never';
}

function phoneTitle(phone) {
  const platform = phone.platform === 'ios' ? 'iPhone' : 'Android';
  const model = phone.model || '';
  if (model.toLowerCase().startsWith(platform.toLowerCase())) return `<strong>${escapeHtml(model)}</strong>`;
  return `<strong>${platform}</strong> ${escapeHtml(model)}`;
}

function placeText(place) {
  return `${escapeHtml(place.phone)} slot ${place.slot}`;
}

function renderSlot(phone, slot) {
  const label = `Slot ${slot.slotNumber}:`;
  const accept = `<button class="accept-sim-btn" data-phone-id="${phone.id}" data-slot="${slot.slotNumber}" type="button">Accept</button>`;
  const from = slot.movedFrom ? ` from ${placeText(slot.movedFrom)}` : '';
  if (slot.state === 'present') {
    const moved = from ? ` <span class="monitor-detail">moved${from}</span>` : '';
    return `${label} <span class="sim-badge sim-ok">✓ ${escapeHtml(slot.simLabel || 'SIM in phone')}</span>${moved}`;
  }
  if (slot.state === 'empty') return `${label} <span class="monitor-detail">empty</span>`;
  if (slot.state === 'removed') {
    const what = escapeHtml(slot.expectedSimLabel || 'SIM');
    const text = slot.movedTo ? `⚠ ${what} moved to ${placeText(slot.movedTo)}` : `⚠ SIM removed${slot.expectedSimLabel ? ` (was ${what})` : ''}`;
    return `${label} <span class="sim-badge sim-alert">${text}</span>${accept}`;
  }
  const text = slot.movedFrom
    ? `⚠ ${escapeHtml(slot.simLabel || 'SIM')} moved here${from} (was ${escapeHtml(slot.expectedSimLabel || 'another SIM')})`
    : `⚠ SIM changed: ${escapeHtml(slot.expectedSimLabel || 'expected SIM')} → ${escapeHtml(slot.simLabel || 'unknown SIM')}`;
  return `${label} <span class="sim-badge sim-alert">${text}</span>${accept}`;
}

// One connection line per SIM slot, lined up with the SIMs column, so each SIM's status is visible.
const slotConnection = {
  present: '<span class="monitor-state monitor-on">● Connected</span>',
  changed: '<span class="monitor-state monitor-warn">● Different SIM</span>',
  removed: '<span class="monitor-state monitor-off">○ SIM removed</span>',
  empty: '<span class="monitor-state monitor-none">○ No SIM</span>',
};

function renderConnection(phone) {
  if (!phone.connected) {
    return `<span class="monitor-state monitor-off">○ Phone offline</span><div class="monitor-detail">Last seen ${formatDate(phone.lastSeenAt)}</div>`;
  }
  if (phone.problem) return `<span class="monitor-state monitor-warn">⚠ ${escapeHtml(phone.problem)}</span>`;
  if (!phone.slots.length) return '<span class="monitor-state monitor-on">● Phone connected</span>';
  return phone.slots.map((slot) => {
    const moved = slot.state === 'removed' && slot.movedTo ? '<span class="monitor-state monitor-warn">○ SIM moved</span>' : null;
    return `<div class="slot-line">${moved || slotConnection[slot.state] || ''}</div>`;
  }).join('');
}

function renderAsset(phone, linkedAssetIds) {
  const linked = allAssets.find((asset) => asset.id === phone.deviceId);
  if (!isAdmin) return linked ? `${escapeHtml(linked.deviceName)} · ${escapeHtml(linked.attachedPc)}` : 'Not linked';
  // An asset can have only one phone, so offer assets that are free or already this phone's.
  const options = allAssets
    .filter((asset) => asset.id === phone.deviceId || !linkedAssetIds.has(asset.id))
    .map((asset) => `<option value="${asset.id}" ${asset.id === phone.deviceId ? 'selected' : ''}>${escapeHtml(asset.deviceName)} · ${escapeHtml(asset.attachedPc)}</option>`)
    .join('');
  return `
    <select class="link-asset-select" data-id="${phone.id}" aria-label="Asset for this phone">
      <option value="">Not linked</option>
      ${options}
    </select>`;
}

function renderPhones() {
  phonesCount.textContent = `${allPhones.length} phone${allPhones.length === 1 ? '' : 's'}`;
  if (!allPhones.length) {
    phonesTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">No phones reported yet. Install the agent on a Mac and plug a phone in.</td></tr>';
    return;
  }
  const linkedAssetIds = new Set(allPhones.map((phone) => phone.deviceId).filter(Boolean));
  phonesTableBody.innerHTML = allPhones.map((phone) => {
    const connection = renderConnection(phone);
    const sims = phone.slots.length ? phone.slots.map((slot) => `<div class="slot-line">${renderSlot(phone, slot)}</div>`).join('') : '—';
    return `
      <tr>
        <td>${phoneTitle(phone)}<div class="monitor-detail">${escapeHtml(phone.osVersion || '')} · ID …${escapeHtml(phone.hardwareId.slice(-4))}</div></td>
        <td>${escapeHtml(phone.agentName || '—')}</td>
        <td>${connection}</td>
        <td>${sims}</td>
        <td>${renderAsset(phone, linkedAssetIds)}</td>
        <td>${isAdmin ? `<button class="delete-btn delete-phone-btn" data-id="${phone.id}" type="button">Remove</button>` : ''}</td>
      </tr>
    `;
  }).join('');
}

async function loadPhones() {
  try {
    [allPhones, allAssets] = await Promise.all([apiRequest('/api/phones'), apiRequest('/api/devices')]);
    renderPhones();
  } catch (error) {
    phonesCount.textContent = 'Unavailable';
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
  await loadPhones();
});

phonesTableBody.addEventListener('click', async (event) => {
  const acceptButton = event.target.closest('.accept-sim-btn');
  if (acceptButton) {
    acceptButton.disabled = true;
    try {
      await apiRequest(`/api/phones/${acceptButton.dataset.phoneId}/slots/${acceptButton.dataset.slot}/accept`, { method: 'POST' });
      showMessage('SIM change accepted.');
      await loadPhones();
    } catch (error) {
      acceptButton.disabled = false;
      showMessage(error.message, true);
    }
    return;
  }

  const removeButton = event.target.closest('.delete-phone-btn');
  if (!removeButton) return;
  if (!window.confirm('Remove this phone and its SIM history? If it is still plugged in, it will reappear as a new phone.')) return;
  try {
    await apiRequest(`/api/phones/${removeButton.dataset.id}`, { method: 'DELETE' });
    showMessage('Phone removed.');
    await loadPhones();
  } catch (error) {
    showMessage(error.message, true);
  }
});

window.addEventListener('live-change', loadPhones);

apiRequest('/api/me')
  .then((me) => { isAdmin = Boolean(me?.isAdmin); })
  .catch(() => {})
  .finally(loadPhones);
