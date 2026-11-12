const currentUserName = document.getElementById('currentUserName');
const logoutBtn = document.getElementById('logoutBtn');
const adminLink = document.getElementById('adminLink');

async function loadCurrentUser() {
  const response = await fetch('/api/me');
  if (response.status === 401) {
    window.location.replace('/login.html');
    return;
  }
  if (!response.ok) return;
  const user = await response.json();
  currentUserName.textContent = user.username;
  if (adminLink) adminLink.hidden = !user.isAdmin;
}

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  window.location.replace('/login.html');
});

loadCurrentUser();
