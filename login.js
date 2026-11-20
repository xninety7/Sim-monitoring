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

// Show "Sign in with Lark" when the server has it set up, and explain a failed Lark sign-in.
const larkErrors = {
  denied: 'Lark sign-in was cancelled.',
  expired: 'The Lark sign-in took too long or was opened in another browser. Please try again.',
  organisation: 'Your Lark account is not part of this organisation.',
  failed: 'Lark sign-in failed. Please try again, or sign in with your password.',
};
const larkError = larkErrors[new URLSearchParams(window.location.search).get('error')];
if (larkError) {
  loginMessage.textContent = larkError;
  loginMessage.hidden = false;
}
fetch('/api/auth/options')
  .then((response) => (response.ok ? response.json() : {}))
  .then((options) => {
    document.getElementById('larkLogin').hidden = !options.lark;
  })
  .catch(() => {});
