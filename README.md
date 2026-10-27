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

## Start the application

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
