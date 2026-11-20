let allUsers = [];
let currentUserId = null;
let resetUserId = null;

const appMessage = document.getElementById('appMessage');
const addUserForm = document.getElementById('addUserForm');
const usersTableBody = document.getElementById('usersTableBody');
const usersCount = document.getElementById('usersCount');
const resetPasswordDialog = document.getElementById('resetPasswordDialog');
const resetPasswordForm = document.getElementById('resetPasswordForm');
const resetPasswordLabel = document.getElementById('resetPasswordLabel');
const cancelResetPasswordBtn = document.getElementById('cancelResetPasswordBtn');
const userDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401) window.location.replace('/login.html');
  if (response.status === 403) window.location.replace('/');
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
  return value ? escapeHtml(userDateFormat.format(new Date(value))) : 'Never';
}

function renderUsers() {
  usersCount.textContent = `${allUsers.length} user${allUsers.length === 1 ? '' : 's'}`;
  usersTableBody.innerHTML = allUsers.map((user) => {
    const isSelf = user.id === currentUserId;
    return `
      <tr>
        <td>
          <strong>${escapeHtml(user.username)}</strong>${isSelf ? ' <span class="you-label">(you)</span>' : ''}
          ${user.usesLark ? `<div class="monitor-detail">Lark${user.displayName ? ` · ${escapeHtml(user.displayName)}` : ''}</div>` : ''}
        </td>
        <td><span class="status-pill ${user.isAdmin ? 'role-admin' : 'role-user'}">${user.isAdmin ? 'Admin' : 'User'}</span></td>
        <td>${formatDate(user.lastLoginAt)}</td>
        <td>${formatDate(user.createdAt)}</td>
        <td>
          <button class="edit-btn reset-password-btn" data-id="${user.id}" type="button">Reset password</button>
          <button class="switch-btn toggle-admin-btn" data-id="${user.id}" type="button" ${isSelf ? 'disabled title="You can\'t remove your own admin access."' : ''}>${user.isAdmin ? 'Remove admin' : 'Make admin'}</button>
          <button class="delete-btn delete-user-btn" data-id="${user.id}" type="button" ${isSelf ? 'disabled title="You can\'t delete your own account."' : ''}>Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function loadUsers() {
  try {
    const [me, users] = await Promise.all([apiRequest('/api/me'), apiRequest('/api/users')]);
    currentUserId = users.find((user) => user.username === me.username)?.id ?? null;
    allUsers = users;
    renderUsers();
  } catch (error) {
    usersCount.textContent = 'Unavailable';
    showMessage(error.message, true);
  }
}

addUserForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(addUserForm);
  const username = String(formData.get('username') || '').trim().toLowerCase();
  try {
    await apiRequest('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        password: String(formData.get('password') || ''),
        isAdmin: formData.get('isAdmin') === 'on',
      }),
    });
    addUserForm.reset();
    await loadUsers();
    showMessage(`Created user ${username}.`);
  } catch (error) {
    showMessage(error.message, true);
  }
});

usersTableBody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  const user = allUsers.find((item) => item.id === Number(button.dataset.id));
  if (!user) return;

  if (button.classList.contains('reset-password-btn')) {
    resetUserId = user.id;
    resetPasswordLabel.textContent = `Set a new password for ${user.username}.`;
    resetPasswordForm.reset();
    resetPasswordDialog.showModal();
    return;
  }

  try {
    if (button.classList.contains('toggle-admin-btn')) {
      await apiRequest(`/api/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isAdmin: !user.isAdmin }),
      });
      showMessage(user.isAdmin ? `${user.username} is no longer an admin.` : `${user.username} is now an admin.`);
    } else if (button.classList.contains('delete-user-btn')) {
      if (!window.confirm(`Delete ${user.username}? They will be signed out and can no longer sign in.`)) return;
      await apiRequest(`/api/users/${user.id}`, { method: 'DELETE' });
      showMessage(`Deleted user ${user.username}.`);
    }
    await loadUsers();
  } catch (error) {
    showMessage(error.message, true);
  }
});

cancelResetPasswordBtn.addEventListener('click', () => resetPasswordDialog.close());

resetPasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const user = allUsers.find((item) => item.id === resetUserId);
  if (!user) return;
  try {
    await apiRequest(`/api/users/${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ password: String(new FormData(resetPasswordForm).get('password') || '') }),
    });
    resetPasswordDialog.close();
    resetUserId = null;
    showMessage(`Password reset for ${user.username}.`);
  } catch (error) {
    showMessage(error.message, true);
  }
});

const agentsTableBody = document.getElementById('agentsTableBody');
const agentsCount = document.getElementById('agentsCount');
const addAgentForm = document.getElementById('addAgentForm');
const newAgentKey = document.getElementById('newAgentKey');
const newAgentName = document.getElementById('newAgentName');
const newAgentToken = document.getElementById('newAgentToken');
const copyAgentTokenBtn = document.getElementById('copyAgentTokenBtn');
let allAgents = [];
function renderAgents() {
  agentsCount.textContent = `${allAgents.length} Mac${allAgents.length === 1 ? '' : 's'}`;
  agentsTableBody.innerHTML = allAgents.length
    ? allAgents.map((agent) => `
      <tr>
        <td><strong>${escapeHtml(agent.name)}</strong></td>
        <td>${formatDate(agent.lastReportAt)}</td>
        <td>${agent.intervalSeconds ? `${agent.intervalSeconds} seconds` : '—'}</td>
        <td>${agent.connectedPhones}</td>
        <td><button class="delete-btn delete-agent-btn" data-id="${agent.id}" type="button">Revoke key</button></td>
      </tr>
    `).join('')
    : '<tr><td colspan="5" class="empty-state">No Mac agents yet.</td></tr>';
}

async function loadAgents() {
  try {
    allAgents = await apiRequest('/api/agents');
    renderAgents();
  } catch (error) {
    agentsCount.textContent = 'Unavailable';
    showMessage(error.message, true);
  }
}

agentsTableBody.addEventListener('click', async (event) => {
  const button = event.target.closest('.delete-agent-btn');
  if (!button) return;
  const agent = allAgents.find((item) => item.id === Number(button.dataset.id));
  if (!agent || !window.confirm(`Revoke the agent key for ${agent.name}? That Mac will stop reporting until it gets a new key.`)) return;
  try {
    await apiRequest(`/api/agents/${agent.id}`, { method: 'DELETE' });
    showMessage(`Revoked the agent key for ${agent.name}.`);
    await loadAgents();
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
    await loadAgents();
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
  loadUsers();
  loadAgents();
});

loadUsers();
loadAgents();
