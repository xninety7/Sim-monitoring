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
        <td><strong>${escapeHtml(user.username)}</strong>${isSelf ? ' <span class="you-label">(you)</span>' : ''}</td>
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

window.addEventListener('live-change', loadUsers);

loadUsers();
