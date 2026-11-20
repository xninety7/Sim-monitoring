// "Sign in with Lark": standard OAuth login with a Lark custom app. It's off until the server has
// LARK_APP_ID and LARK_APP_SECRET. The first time someone signs in, a regular (non-admin) account
// is created for them; admins can then promote them on the Admin page.
//   LARK_APP_ID, LARK_APP_SECRET  from the app's Credentials page in the Lark Developer Console
//   LARK_TENANT_KEY   optional: only accept people from this Lark organisation
//   LARK_REDIRECT_URI optional: defaults to https://<this site>/api/auth/lark/callback
//   LARK_SCOPE        optional: extra permissions to request, e.g. contact:user.email:readonly
import { randomBytes } from 'node:crypto';

const authorizeUrl = 'https://accounts.larksuite.com/open-apis/authen/v1/authorize';
const tokenUrl = 'https://open.larksuite.com/open-apis/authen/v2/oauth/token';
const userInfoUrl = 'https://open.larksuite.com/open-apis/authen/v1/user_info';
const stateCookie = 'lark_state';
const stateMaxAgeSeconds = 10 * 60;

// Turns a Lark name or email into a username allowed by the users table, e.g. "Lyden Faye" -> "lyden.faye".
function usernameBase(info) {
  const email = info.enterprise_email || info.email || '';
  for (const candidate of [email.split('@')[0], info.en_name, info.name]) {
    const cleaned = String(candidate || '')
      .normalize('NFKD')
      .toLowerCase()
      .replace(/\s+/g, '.')
      .replace(/[^a-z0-9._-]/g, '')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 40);
    if (cleaned) return cleaned;
  }
  return `lark-${String(info.open_id).slice(-8).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

async function larkJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.code !== undefined && body.code !== 0)) {
    throw new Error(`Lark ${new URL(url).pathname} failed: ${body.code ?? response.status} ${body.error_description || body.msg || body.error || ''}`.trim());
  }
  return body;
}

export function registerLarkLogin(app, { pool, startSession, logActivity, hashPassword }) {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  const enabled = Boolean(appId && appSecret);

  function redirectUri(req) {
    return process.env.LARK_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/lark/callback`;
  }

  function fail(res, reason) {
    res.clearCookie(stateCookie, { path: '/api/auth/lark' });
    return res.redirect(`/login.html?error=${reason}`);
  }

  async function findOrCreateUser(info) {
    const existing = await pool.query(
      'UPDATE users SET display_name = $2 WHERE lark_open_id = $1 RETURNING id, username',
      [info.open_id, info.name || null],
    );
    if (existing.rowCount) return existing.rows[0];

    // New person: pick a free username. Never take over an existing account by name.
    const base = usernameBase(info);
    // People without Lark access keep no usable password unless an admin sets one.
    const unusablePassword = await hashPassword(randomBytes(32).toString('hex'));
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const username = attempt === 1 ? base : `${base.slice(0, 46)}-${attempt}`;
      const created = await pool.query(
        `INSERT INTO users (username, password_hash, lark_open_id, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING id, username`,
        [username, unusablePassword, info.open_id, info.name || null],
      );
      if (created.rowCount) {
        await logActivity({ actorName: 'Lark sign-in' }, 'Created user', `${username} (${info.name || 'Lark user'}) on first Lark sign-in`);
        return created.rows[0];
      }
      // Another request created this person at the same moment.
      const raced = await pool.query('SELECT id, username FROM users WHERE lark_open_id = $1', [info.open_id]);
      if (raced.rowCount) return raced.rows[0];
    }
    throw new Error('Could not find a free username.');
  }

  // Lets the login page show the Lark button only when Lark sign-in is set up.
  app.get('/api/auth/options', (_req, res) => {
    res.json({ lark: enabled });
  });

  app.get('/api/auth/lark/start', (req, res) => {
    if (!enabled) return res.redirect('/login.html');
    const state = randomBytes(24).toString('base64url');
    res.cookie(stateCookie, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: stateMaxAgeSeconds * 1000,
      path: '/api/auth/lark',
    });
    const params = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri(req), state });
    if (process.env.LARK_SCOPE) params.set('scope', process.env.LARK_SCOPE);
    return res.redirect(`${authorizeUrl}?${params}`);
  });

  app.get('/api/auth/lark/callback', async (req, res) => {
    if (!enabled) return res.redirect('/login.html');
    const { code, state, error } = req.query;
    if (error) return fail(res, 'denied');
    const savedState = new RegExp(`(?:^|;\\s*)${stateCookie}=([^;]+)`).exec(req.get('Cookie') || '')?.[1];
    if (typeof code !== 'string' || typeof state !== 'string' || !savedState || state !== savedState) {
      return fail(res, 'expired');
    }

    try {
      const token = await larkJson(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: appId,
          client_secret: appSecret,
          code,
          redirect_uri: redirectUri(req),
        }),
      });
      const { data: info } = await larkJson(userInfoUrl, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!info?.open_id) throw new Error('Lark returned no user id.');
      if (process.env.LARK_TENANT_KEY && info.tenant_key !== process.env.LARK_TENANT_KEY) {
        console.warn(`Lark sign-in refused for another organisation (tenant ${info.tenant_key}).`);
        return fail(res, 'organisation');
      }

      const user = await findOrCreateUser(info);
      res.clearCookie(stateCookie, { path: '/api/auth/lark' });
      await startSession(req, res, user.id);
      return res.redirect('/');
    } catch (failure) {
      console.error('Lark sign-in failed:', failure.message);
      return fail(res, 'failed');
    }
  });

}
