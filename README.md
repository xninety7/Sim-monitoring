# SIM & Phone Monitor

A shared SIM/device monitoring dashboard backed by an Express API and PostgreSQL. Device records are stored centrally so teammates using the same deployed app see the same inventory and changes.

## Features
- Shared PostgreSQL device inventory
- Search and status filtering
- Add and delete devices
- Edit and persist Last Seen values
- Transfer or swap SIM assignments between phones
- Optional one-time import of saved records from a browser

## Requirements
- Node.js 20 or newer
- PostgreSQL 14 or newer

## Configure PostgreSQL

Create a database, for example `sim_monitoring`, and copy `.env.example` to `.env`. Set `DATABASE_URL` to the connection string for your PostgreSQL database. For local development, update the example connection string to match your local PostgreSQL user/password.

The application creates its tables and indexes on startup. For hosted PostgreSQL services that require TLS, set `PGSSL=true`.

## Local development

```bash
npm install
npm start
```

Open http://localhost:8000.

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

### 2. Install Nginx and HTTP Basic Auth tooling

```bash
sudo dnf install -y nginx httpd-tools
sudo htpasswd -c /etc/nginx/sim-monitoring.htpasswd team
```

Choose a unique password at the prompt. This is an interim shared-team access gate; for a larger team, add individual accounts/roles in the application.

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

Replace `monitor.example.com` with your domain. The Nginx config redirects HTTP to HTTPS, requires the Basic Auth credentials created above, and proxies to the loopback-only Node service. Test `https://YOUR_DOMAIN` in a browser. Keep certificate renewal enabled and test its renewal procedure with your certificate provider.

If SELinux is enforcing and Nginx reports a proxy connection error, allow the web server to connect to the local Node port:

```bash
sudo setsebool -P httpd_can_network_connect 1
sudo systemctl reload nginx
```

The application currently has no built-in user accounts or role permissions. The Nginx password gate is only a simple interim protection; do not publish the site without HTTPS and access control.

## API overview

- `GET /api/health` — check API and database connectivity
- `GET /api/devices` — read shared device inventory
- `POST /api/devices` — add a device
- `PATCH /api/devices/:id` — update supported device fields
- `DELETE /api/devices/:id` — delete a device
- `POST /api/devices/:id/switch-sim` — transactionally transfer/swap SIM assignment
- `POST /api/devices/import` — import records once into an empty database

## Important

The sample front-end status values are still manually managed; this project does not yet communicate with phones or cellular carriers to determine real SIM activity. Share the app by deploying the server where teammates can reach it and configuring a shared PostgreSQL database. Do not expose the database connection string in front-end code or commit `.env`.
