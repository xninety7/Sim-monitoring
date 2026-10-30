const activityList = document.getElementById('activityList');
const activityCount = document.getElementById('activityCount');
const activityPagination = document.getElementById('activityPagination');
const activityPreviousBtn = document.getElementById('activityPreviousBtn');
const activityNextBtn = document.getElementById('activityNextBtn');
const activityPageInfo = document.getElementById('activityPageInfo');

let currentPage = 1;
let pageCount = 1;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

async function loadActivity(page = 1) {
  activityList.innerHTML = '<li class="activity-empty">Loading activity…</li>';
  try {
    const response = await fetch(`/api/activity?page=${page}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${response.status}).`);
    }

    const result = await response.json();
    currentPage = result.page;
    pageCount = result.pageCount;
    activityCount.textContent = `${result.total} action${result.total === 1 ? '' : 's'}`;
    activityPageInfo.textContent = `Page ${currentPage} of ${pageCount}`;
    activityPagination.hidden = pageCount <= 1;
    activityPreviousBtn.disabled = currentPage <= 1;
    activityNextBtn.disabled = currentPage >= pageCount;

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
  } catch (error) {
    activityCount.textContent = 'Unavailable';
    activityList.innerHTML = `<li class="activity-empty">${escapeHtml(error.message || 'Activity log is unavailable.')}</li>`;
    activityPagination.hidden = true;
  }
}

activityPreviousBtn.addEventListener('click', () => {
  if (currentPage > 1) loadActivity(currentPage - 1);
});

activityNextBtn.addEventListener('click', () => {
  if (currentPage < pageCount) loadActivity(currentPage + 1);
});

loadActivity();
