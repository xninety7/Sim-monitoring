# SIM & Phone Monitor

A shared SIM/device monitoring dashboard backed by an Express API and PostgreSQL. Device records are stored centrally so teammates using the same deployed app see the same inventory and changes.

## Features
- Shared PostgreSQL device inventory
- One or two phone numbers per asset
- Search and status filtering
- Add and delete devices
- Edit and persist Last Seen values
- Move a phone number between asset slots or swap occupied slots
- Optional one-time import of saved records from a browser

## Requirements
- Node.js 20 or newer
- PostgreSQL 14 or newer

## Configure PostgreSQL

Create a database, for example `sim_monitoring`, and copy `.env.example` to `.env`. Set `DATABASE_URL` to the connection string for your PostgreSQL database. For local development, update the example connection string to match your local PostgreSQL user/password.

The application creates its tables and indexes on startup. For hosted PostgreSQL services that require TLS, set `PGSSL=true`.

Phone numbers are stored by asset slot (1 or 2), so an asset can have a separate number in each slot. On startup, existing asset-level phone numbers are migrated into slot 1; the old asset-level field is then cleared to avoid duplicate tracking. SIM-card and handset identifiers such as SIM number, ICCID, and IMEI are not tracked.

## Local development

```bash
npm install
npm run create-user -- yourname --admin
npm start
```

Open http://localhost:8000 and sign in with the account you created.

For development with automatic server restart:

```bash
npm run dev
```

## Migrate existing browser data

The backend does not automatically seed fake records or overwrite browser data. When the database is empty and the current browser has records saved under `sim-monitoring-devices`, the dashboard shows **Import this browser's saved devices**. Click it once to copy those records into PostgreSQL. Only the first import succeeds; later imports are rejected to prevent accidental duplicates.

Records that exist only in other teammates' browsers must be imported from those browsers individually before the database contains records, or collected and merged into a single import file first.

## Public production deployment on Alibaba Cloud Linux 3

The API binds to `127.0.0.1:8000` by default. Put Nginx in front of it; do not expose Node port 8000 or PostgreSQL port 5432 to the internet. The example deployment files are in `deploy/`.

### 1. DNS and security group

- Point a domain's DNS A record to the ECS public IP and wait for it to resolve.
- In the ECS security group, allow inbound TCP 80 and 443. Restrict SSH (22) to administrator IPs. Do not allow 8000 or 5432 from the internet.
- Keep PostgreSQL bound to localhost for a same-instance database.

### 2. Install Nginx

```bash
sudo dnf install -y nginx
```

### 3. Install the app as a non-root service

```bash
sudo useradd --system --home-dir /opt/sim-monitoring --shell /sbin/nologin sim-monitor
sudo mkdir -p /opt/sim-monitoring /etc/sim-monitoring
sudo cp -a ~/Sim-monitoring/. /opt/sim-monitoring/
cd /opt/sim-monitoring
sudo npm ci --omit=dev
sudo chown -R root:sim-monitor /opt/sim-monitoring
sudo chmod -R g+rX /opt/sim-monitoring
command -v node
```

Check the output of `command -v node`. If it is not `/usr/bin/node`, update `ExecStart` in `deploy/sim-monitoring.service` to use the returned absolute path.

Create the service environment file and enter the working database URL; do not put credentials in the unit file or shell command history:

```bash
sudo install -o root -g root -m 600 /dev/null /etc/sim-monitoring/app.env
sudo vi /etc/sim-monitoring/app.env
```

Add `DATABASE_URL=postgresql://sim_monitor:YOUR_PASSWORD@127.0.0.1:5432/sim_monitoring` and `HOST=127.0.0.1`. Replace the password locally. If it contains URL-reserved characters, percent-encode them in the URL. Save and exit, then install and start the systemd service:

```bash
sudo install -o root -g root -m 644 deploy/sim-monitoring.service /etc/systemd/system/sim-monitoring.service
sudo systemctl daemon-reload
sudo systemctl enable --now sim-monitoring
sudo systemctl status sim-monitoring --no-pager
curl http://127.0.0.1:8000/api/health
```

The health endpoint must report `"database":"connected"` before continuing.

### 4. Install HTTPS and Nginx configuration

Obtain a valid TLS certificate for the domain (Alibaba Cloud SSL Certificates or a trusted ACME/Let's Encrypt client). The provided Nginx config expects certificate files at `/etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem` and `privkey.pem`; adjust those paths if your certificate provider stores them elsewhere.

Replace every `YOUR_DOMAIN` in `deploy/nginx/sim-monitoring.conf` with the real domain, then install it:

```bash
sudo sed 's/YOUR_DOMAIN/monitor.example.com/g' deploy/nginx/sim-monitoring.conf | sudo tee /etc/nginx/conf.d/sim-monitoring.conf >/dev/null
sudo nginx -t
sudo systemctl enable --now nginx
```

Replace `monitor.example.com` with your domain. The Nginx config redirects HTTP to HTTPS and proxies to the loopback-only Node service. Test `https://YOUR_DOMAIN` in a browser. Keep certificate renewal enabled and test its renewal procedure with your certificate provider.

If SELinux is enforcing and Nginx reports a proxy connection error, allow the web server to connect to the local Node port:

```bash
sudo setsebool -P httpd_can_network_connect 1
sudo systemctl reload nginx
```

### 5. Create user accounts

Everyone signs in on the app's login page with their own account. There is no public sign-up. Create the first admin account from the server:

```bash
sudo bash -c 'set -a; . /etc/sim-monitoring/app.env; cd /opt/sim-monitoring && node scripts/create-user.js yourname --admin'
```

You'll be asked for the password twice (8 characters minimum). After that, sign in and open **Users** in the dashboard header to add teammates, reset passwords, make or remove admins, and delete accounts. Only admins see the Users page. Admins can't remove their own admin access or delete themselves, so at least one admin always remains.

If every admin is locked out, run the command above again: for an existing username it resets the password (signing them out everywhere), and `--admin` restores admin access.

Sessions last 7 days. After 10 failed sign-ins from one IP address, sign-in is blocked for 15 minutes. Do not publish the site without HTTPS, because the session cookie is only marked secure when served over HTTPS.

### Activity log and identifying users

The dashboard records successful device additions, edits, deletions, phone-number moves/swaps, and imports in PostgreSQL. Open the separate Recent activity page from the dashboard header to browse the log ten actions at a time. It does not record every button click or unsuccessful attempt. The actor is the signed-in user. Clicking **Check** on an asset records the signed-in user and the current date and time in its **Last Seen** column, and is logged as "Checked asset".

For assets with two numbers, set **Phone number slots** to **Two numbers** and fill each slot's phone number and TELCO provider. **Move number** moves the selected source slot to a destination slot; if that destination slot is occupied, the phone number and provider move together as a swap. Changes are transactional and logged with both asset codes and slot numbers.

Give each teammate their own account so the log can tell them apart.

Open pages update live: when anyone adds, edits, checks, moves or deletes something, every signed-in browser refreshes its data within a second or two. The **● Live** marker next to the signed-in user shows the connection is active. This uses Server-Sent Events on `/api/events`; the app sends `X-Accel-Buffering: no`, so the Nginx config needs no changes. Restart the app after deploying so it creates new tables through the normal schema initialization.

## Automatic SIM monitoring

A small agent on each office Mac checks the phones plugged into it every 30 seconds and reports to the dashboard. For each linked asset, the dashboard then shows whether the phone is **connected**, and for each SIM slot whether the SIM is **present**, **removed** or **changed** (swapped for a different SIM, even from the same carrier). Changes appear live and are recorded in Recent activity. A phone is marked offline about 90 seconds after its Mac stops reporting.

| | Android | iPhone |
|---|---|---|
| SIM removed / swapped / present | ✅ (via Android's per-SIM subscription id) | ✅ (via the SIM serial) |
| Phone number read automatically | ❌ | ✅ |
| One-time setup on the phone | Turn on USB debugging and tap **Allow** | Tap **Trust This Computer** |

Only a hash of each SIM serial leaves the Mac.

### Set up a Mac

1. On the dashboard, open **Users** → **Mac agents**, enter the Mac's name (e.g. `PC-9`) and click **Create agent key**. Copy the key; it is shown only once.
2. On that Mac, install the requirements and run the installer from the `agent/` folder of this repository:

   ```bash
   brew install node android-platform-tools libimobiledevice
   cd agent && ./install.sh
   ```

   Paste the agent key when asked. The installer sends a test report, then sets the agent to run in the background and start at login. Its log is `~/Library/Logs/sim-agent.log`.
3. Plug in each phone and complete the phone's one-time setup (table above).
4. Back on **Users** → **Monitored phones**, pick the asset for each phone that appears.

Keep the Macs awake and signed in (System Settings → Energy → **Prevent automatic sleeping when the display is off**); a sleeping Mac makes its phones show as offline.

When a slot shows ⚠ **SIM changed** or ⚠ **SIM removed** and the change was intentional, click **Accept** on the dashboard to make it the new expected state. To check what a Mac can see without sending anything, run `node agent/sim-agent.js --dry-run` (or `node scripts/sim-probe.js` for more detail).

To stop the agent on a Mac: `launchctl bootout gui/$(id -u)/me.bewen.sim-agent`. To stop a Mac from reporting, revoke its key on the Users page.

## API overview

- `GET /api/health` — check API and database connectivity
- `POST /api/login` — sign in with `username` and `password`; sets the session cookie
- `POST /api/logout` — end the current session
- `GET /api/me` — the signed-in user and whether they are an admin
- `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id` — manage accounts (admins only)
- `GET /api/devices` — read shared device inventory
- `POST /api/devices` — add a device
- `PATCH /api/devices/:id` — update supported device fields
- `DELETE /api/devices/:id` — delete a device
- `POST /api/devices/:id/check` — record the signed-in user and current time as the asset's last check
- `POST /api/devices/:id/switch-sim` — move a populated `sourceSlot` phone number to a `targetId`/`targetSlot`; swaps if the destination is occupied
- `POST /api/devices/import` — import records once into an empty database
- `GET /api/activity` — retrieve the latest activity events
- `GET /api/events` — live stream that announces each change (Server-Sent Events)
- `POST /api/agent/report` — agent report of connected phones and SIMs (authenticated with an agent key, not a session)
- `GET /api/phones` — monitored phones and their SIM states
- `PATCH /api/phones/:id`, `DELETE /api/phones/:id` — link a phone to an asset, or remove it (admins only)
- `POST /api/phones/:id/slots/:slot/accept` — accept a SIM change or removal as the new expected state
- `GET /api/agents`, `POST /api/agents`, `DELETE /api/agents/:id` — manage Mac agent keys (admins only)

Every endpoint except health, login and the agent report requires a signed-in session.

## Important

The sample front-end status values are still manually managed; this project does not yet communicate with phones or cellular carriers to determine real SIM activity. Share the app by deploying the server where teammates can reach it and configuring a shared PostgreSQL database. Do not expose the database connection string in front-end code or commit `.env`.
