# TradePulse: Trader Dashboard

An offline desktop app that turns a trader's sales records into analytics, monthly revenue reports and batch-level stock tracking. I built it for an import retail business to replace manual spreadsheet tracking. Everything runs locally, so no sales data leaves the machine.

![Dashboard](screenshots/dashboard.png)

## Features

- **Dashboard:** top-selling product, highest-spending customer and peak sales month at a glance, plus a custom report generator with filters and support for user-defined fields.
- **Trends:** revenue trend chart and a month-over-month breakdown with percentage change.
- **Sheet:** a spreadsheet view with formulas (SUM, AVERAGE, COUNT, COUNTA, MIN, MAX, IF, SUMIF, COUNTIF and lookups). Load transactions, save edits back to the database, or export to `.xlsx`.
- **Batches:** track each import batch and its items by auto-generated traceable codes, with remaining vs initial quantity. Sales and returns update stock and are recorded as transactions, so batch activity feeds the dashboard and trends. Deleting a batch keeps its sales history.
- **Excel import:** bring in existing sales records from an Excel file.

| Trends | Sheet | Batches |
|---|---|---|
| ![Trends](screenshots/trends.png) | ![Sheet](screenshots/sheet.png) | ![Batches](screenshots/batches.png) |

## Tech stack

Rust, Tauri, React, TypeScript, Vite, SQLite (via `rusqlite`)

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org)
- [Rust](https://www.rust-lang.org/tools/install)
- The [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (on Windows: WebView2 and the C++ build tools)

### Run in development

```bash
npm install
npm run tauri dev
```

### Build an installer

```bash
npm run tauri build
```

## Data

The SQLite database is created automatically on first launch in the app's data folder (on Windows: `%APPDATA%\com.adama.trader-dashboard\trader.db`). No real data is included in this repository.

To try the app with fictional data:

1. Run the app once, then close it so it creates an empty database.
2. Load the sample data (PowerShell). This only works on a fresh, empty database:

```powershell
sqlite3 "$env:APPDATA\com.adama.trader-dashboard\trader.db" ".read sample-data/seed.sql"
```

3. Start the app again.

If you already have your own data, back up `trader.db` first or use a separate machine.

## Project structure

```
src/          React + TypeScript frontend
src-tauri/    Rust backend (Tauri commands, SQLite access)
sample-data/  Fictional seed data for demos
screenshots/  Images used in this README
```