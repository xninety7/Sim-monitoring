const loginForm = document.getElementById('loginForm');
const loginMessage = document.getElementById('loginMessage');
const loginSubmit = loginForm.querySelector('button[type="submit"]');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  loginSubmit.disabled = true;
  loginMessage.hidden = true;

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: String(formData.get('username') || ''),
        password: String(formData.get('password') || ''),
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Sign-in failed (${response.status}).`);
    }
    window.location.replace('/');
  } catch (error) {
    loginMessage.textContent = error.message;
    loginMessage.hidden = false;
    loginForm.elements.password.value = '';
    loginForm.elements.password.focus();
  } finally {
    loginSubmit.disabled = false;
  }
});
