const currentUserName = document.getElementById('currentUserName');
const logoutBtn = document.getElementById('logoutBtn');
const adminLink = document.getElementById('adminLink');
const liveStatus = document.getElementById('liveStatus');
let liveRefreshTimer = null;

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

function setLiveStatus(isLive) {
  liveStatus.textContent = isLive ? 'Live' : 'Reconnecting…';
  liveStatus.classList.toggle('offline', !isLive);
}

function notifyLiveChange() {
  // Batch bursts of changes (such as an import) into one refresh.
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(() => window.dispatchEvent(new Event('live-change')), 300);
}

// Pages listen for 'live-change' and reload their data when anyone changes something.
function connectLiveUpdates({ reconnecting = false } = {}) {
  const events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    setLiveStatus(true);
    // Catch up on anything that changed while the connection was down.
    if (reconnecting) notifyLiveChange();
    reconnecting = true;
  });
  events.addEventListener('change', notifyLiveChange);
  events.addEventListener('error', () => {
    setLiveStatus(false);
    // The browser retries on its own unless the server refused the stream, e.g. after signing out.
    if (events.readyState === EventSource.CLOSED) {
      loadCurrentUser();
      setTimeout(() => connectLiveUpdates({ reconnecting: true }), 5000);
    }
  });
}

loadCurrentUser();
connectLiveUpdates();
