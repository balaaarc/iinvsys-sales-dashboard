# IINVSYS Sales Dashboard — Manual & Automation Testing Guide

> **Version:** 2.0
> **Date:** 2026-04-02
> **Total automated tests:** 236 (134 original + 102 new frontend-contract tests)

---

## Part A — Running the Automation Test Suite

### Prerequisites

```bash
cd /Users/mac_user_01/Desktop/Sales_Dashboard/backend
npm install          # install all deps including jest, supertest, mongodb-memory-server
```

No external MongoDB or running server is needed — tests use an in-memory database.

---

### A1 — Run Everything

```bash
npm test
```

**Expected output:**
```
Test Suites: 9 passed, 9 total
Tests:       236 passed, 236 total
Time:        ~90 seconds
```

> **Critical:** Always use `npm test`, not `npx jest` directly.
> The package.json test script includes `--runInBand` (serial execution) which is mandatory — all suites share the same MongoDB memory server. Running in parallel causes intermittent failures due to collection teardown races.

---

### A2 — Run a Single Suite

```bash
# New contract tests (bugs BUG-01 through BUG-04)
npm test -- --testPathPattern="frontend-contracts"

# Settings feature only
npm test -- --testPathPattern="settings"

# Bulk import + lead filters
npm test -- --testPathPattern="lead-filters"

# Analytics KPIs
npm test -- --testPathPattern="analytics"

# Expo management + referrers
npm test -- --testPathPattern="expos"
```

---

### A3 — Test Suite Index

| File | Tests | What It Covers |
|------|-------|----------------|
| `tests/auth.test.js` | 21 | Login, /me, password change, RBAC on registration |
| `tests/leads.test.js` | 9 | Lead CRUD, agent scoping, bulk import (basic) |
| `tests/agents.test.js` | 6 | Agent CRUD, stats, soft/hard delete |
| `tests/products.test.js` | 9 | Product CRUD, SKU uniqueness, soft delete |
| `tests/lead-filters.test.js` | 34 | Filters, pagination, model virtuals, edge cases |
| `tests/expos.test.js` | 31 | Expo CRUD, referrers, auto-status hook |
| `tests/analytics.test.js` | 19 | KPI overview, trends, expo ROI |
| `tests/settings.test.js` | 18 | Settings list, update, get by key |
| `tests/frontend-contracts.test.js` | **102** | **API response shapes consumed by app.js** |
| **Total** | **236** | |

---

### A4 — Coverage Report

```bash
npm run test:coverage
```

HTML report is written to `backend/coverage/lcov-report/index.html`.
Open in browser:
```bash
open backend/coverage/lcov-report/index.html
```

---

### A5 — Debugging a Failing Test

When a test fails, Jest prints the full diff. Common patterns:

| Symptom | Likely cause |
|---------|-------------|
| `cannot read property of undefined` | API response shape changed — check the response.js utility |
| `401 received, expected 200` | JWT signing uses wrong secret (check `JWT_SECRET` env var = `test-secret-key-for-jest`) |
| `MongoMemoryServer instance failed to start` | A previous test run crashed and left a stray `mongod` process — run `pkill -f mongod` then retry |
| Tests fail when run in parallel but pass individually | Missing `--runInBand` — always use `npm test`, not `npx jest` |

---

## Part B — Bugs Fixed (Changelog)

Four bugs were found and patched in `app.js` on 2026-04-02:

### BUG-01 — Settings page crashes: `settings.forEach is not a function`

| | Detail |
|---|---|
| **File** | `app.js` line 1451 |
| **Symptom** | Navigating to System Settings shows red error: *"Failed to load settings: settings.forEach is not a function"* |
| **Root cause** | `renderSettings()` did `const settings = res.data \|\| []` but `res.data` is `{ settings: [...], map: {...} }` — an object, not an array |
| **Fix** | Changed to `const settings = (res.data && res.data.settings) ? res.data.settings : []` |
| **Test** | `frontend-contracts.test.js` → `[BUG-01] res.data is an OBJECT...` |

### BUG-02 — Settings Save button silently fails

| | Detail |
|---|---|
| **File** | `app.js` line 1509 |
| **Symptom** | Clicking **Save** next to any setting shows "Setting saved" toast but the value reverts on next page load |
| **Root cause** | `saveSetting()` sent `{ updates: [{ key, value }] }` (array) but the backend expects `{ updates: { [key]: value } }` (object map). `Object.entries()` on an array gives index-based keys (`"0"`, `"1"`) so MongoDB upserts a record with key `"0"` instead of the intended key |
| **Fix** | Changed to `{ updates: { [key]: value } }` |
| **Test** | `frontend-contracts.test.js` → `[BUG-02] CORRECT format...` and `[BUG-02] WRONG format...` |

### BUG-03 — CSV Bulk Import: "Import Leads" button fails with 404

| | Detail |
|---|---|
| **File** | `app.js` line 1320 |
| **Symptom** | After uploading a CSV and clicking **Import Leads**, the import spinner spins then shows "Import failed" error |
| **Root cause** | Frontend called `POST /api/leads/bulk-import` but the backend route is `POST /api/leads/bulk` |
| **Fix** | Changed URL to `/leads/bulk` |
| **Test** | `frontend-contracts.test.js` → `[BUG-03] POST /api/leads/bulk exists...` and `[BUG-03] POST /api/leads/bulk-import returns 404...` |

### BUG-04 — Bulk Import result shows wrong duplicate count

| | Detail |
|---|---|
| **File** | `app.js` line 1326 |
| **Symptom** | After a successful import, the result card shows "0 duplicates skipped" even when there are real duplicates |
| **Root cause** | Frontend read `res.data?.skipped` but the backend response field is `res.data.duplicates` |
| **Fix** | Changed to `res.data?.duplicates` |
| **Test** | `frontend-contracts.test.js` → `[BUG-04] response has .imported and .duplicates (NOT .skipped)` |

---

## Part C — Manual Test Cases

Use the production URL **https://iinvsys-sales.vercel.app** or local server `http://localhost:3456`.

### Demo Credentials

| Role | Email | Password |
|------|-------|----------|
| Super Admin | admin@iinvsys.com | Admin@123 |
| Sales Manager | manager@iinvsys.com | Manager@123 |
| Sales Agent | rahul@iinvsys.com | Agent@123 |
| Readonly | viewer@iinvsys.com | Viewer@123 |

---

### C1 — Authentication

| # | Steps | Expected Result | Pass/Fail |
|---|-------|----------------|-----------|
| C1.1 | Open app → enter wrong password → click Sign In | Red "Invalid credentials" message appears for ~3 seconds; stays on login page | |
| C1.2 | Enter correct admin credentials → click Sign In | Loader appears → Overview page loads with KPI cards | |
| C1.3 | Reload page after login | Session restores automatically; "Restoring session…" loader appears briefly | |
| C1.4 | Click Logout | Returns to login screen; token cleared from localStorage | |
| C1.5 | Log in as Agent (rahul@iinvsys.com) | Sees "My Leads" and "My Stats" pages only; Leads/Agents/Products/Expos nav hidden | |
| C1.6 | Open browser devtools → Network tab → check login response | Response body has `data.token` (string) and `data.user` (object without `password` field) | |
| C1.7 | Click the password eye icon on login form | Password toggles between hidden and visible | |
| C1.8 | Click a demo credential row | Email and password fields auto-fill | |

---

### C2 — System Settings **(BUG-01 + BUG-02)**

| # | Steps | Expected Result | Pass/Fail |
|---|-------|----------------|-----------|
| C2.1 | Log in as Super Admin → click Settings nav | Settings page loads with grouped sections: Branding, Pipeline, Products, Agents, Expos, System | |
| C2.2 | Verify no error message appears | **No** "Failed to load settings: settings.forEach is not a function" error | |
| C2.3 | Find "Company Name" field → change value to "Test Corp" → click Save | Toast: "Setting saved"; no page reload | |
| C2.4 | Navigate away (click Overview) → come back to Settings | "Company Name" field still shows "Test Corp" | |
| C2.5 | Open Network tab → watch PUT /api/settings request body | Body is `{"updates":{"company.name":"Test Corp"}}` — an **object**, NOT `[{"key":"company.name","value":"Test Corp"}]` | |
| C2.6 | Change "Overdue After (days)" (number field) to 14 → Save | Toast: "Setting saved" | |
| C2.7 | Toggle "Allow Self Registration" switch → Save | Toggle state persists after navigation | |
| C2.8 | Log in as Manager → go to Settings | All fields are greyed out (readonly/disabled); **no Save buttons** visible | |
| C2.9 | Log in as Agent → check sidebar | Settings nav link is not visible in the sidebar | |

---

### C3 — Lead Management

| # | Steps | Expected Result | Pass/Fail |
|---|-------|----------------|-----------|
| C3.1 | Admin: click "New Lead" (top right) or press **N** | Lead modal opens with empty form | |
| C3.2 | Submit form with Name empty | Toast: "Name and Phone are required" | |
| C3.3 | Fill Name + Phone, select Source: Expo, Agent: any → click Capture Lead | Modal closes; new card appears in "NEW" kanban column | |
| C3.4 | Click the new lead card | Edit modal opens with all fields pre-filled | |
| C3.5 | Change Stage to "Won" → click Save Changes | Card moves to "CLOSED WON" column | |
| C3.6 | Click lead card → click Delete (red button) → confirm | Lead disappears from board | |
| C3.7 | Use Stage filter dropdown → select "Proposal" | Only proposal-stage leads show across all columns | |
| C3.8 | Type in search box | Cards filter in real-time by name/phone/source | |
| C3.9 | Log in as Agent → click "New Lead" | Form auto-assigns lead to the agent themselves | |
| C3.10 | Agent: open own lead → try editing Name field | Name field is greyed out (readonly); only Stage and Notes are editable | |

---

### C4 — Bulk CSV Import **(BUG-03 + BUG-04)**

| # | Steps | Expected Result | Pass/Fail |
|---|-------|----------------|-----------|
| C4.1 | Admin: click "Bulk Import" button | Import wizard modal opens at Step 1 | |
| C4.2 | Click "Download Template" | CSV file downloads with header: `name,phone,email,source,expo,products,value,notes` | |
| C4.3 | Click Step 2 without uploading a file | Error: "Please upload a file or paste CSV text" | |
| C4.4 | Paste valid CSV with 3 rows → click "Parse & Preview" | Step 3 shows preview table; summary shows "3 rows parsed \| 3 new" | |
| C4.5 | Include one row whose phone matches an existing lead | Preview shows that row as "DUP" badge; summary shows "2 new \| 1 duplicate" | |
| C4.6 | Click "Import Leads" | **Step 4 success screen** appears (not error); shows "2 Leads Imported" | |
| C4.7 | Verify duplicate count on success screen | Shows "1 duplicates skipped" (not "0 duplicates skipped") | |
| C4.8 | Open Network tab before clicking Import → check request URL | Request goes to `POST /api/leads/bulk` (not `/bulk-import`) | |
| C4.9 | Open Leads page after import | 2 new lead cards visible | |
| C4.10 | Log in as Agent → try Bulk Import | Bulk Import button is not visible in the UI | |

---

### C5 — Agent Management

| # | Steps | Expected Result | Pass/Fail |
|---|-------|----------------|-----------|
| C5.1 | Admin: click Agents nav | Agent cards grid renders with KPI stats | |
| C5.2 | Click "Add Agent" | Agent modal opens with empty form | |
| C5.3 | Submit with Name missing | Toast: "Name, email, phone and territory are required" | |
| C5.4 | Fill all fields → click "Save Agent" | Toast: "Agent created — credentials sent to their email"; new card appears | |
| C5.5 | Click "View Leads" on an agent card | Navigates to Leads page with that agent's filter pre-selected | |
| C5.6 | Click "Deactivate" on an active agent | Card shows "INACTIVE" badge; button changes to "Reactivate" | |
| C5.7 | Click "⚠ Hard Delete" (superadmin only) → confirm | Agent card disappears; agent's leads become unassigned | |
| C5.8 | Log in as Manager → check agent cards | No "⚠ Hard Delete" button visible | |

---

### C6 — Product Management

| # | Steps | Expected Result | Pass/Fail |
|---|-------|----------------|-----------|
| C6.1 | Admin: click Products nav | Table renders with SKU, Name, Category, Price, Lead Interest columns | |
| C6.2 | Click "Add Product" | Product modal opens | |
| C6.3 | Submit with duplicate SKU | Toast: "SKU already exists" (409 from API) | |
| C6.4 | Fill valid form → click "Add Product" | New row appears in table; toast: "Product added" | |
| C6.5 | Click "✎ Edit" on any product | Modal pre-fills existing values | |
| C6.6 | Click "🗑 Delete" → confirm | Product removed from table | |
| C6.7 | Use category filter dropdown | Table filters to matching category only | |
| C6.8 | Type in product search box | Filters by name or SKU in real-time | |

---

### C7 — Expo Management

| # | Steps | Expected Result | Pass/Fail |
|---|-------|----------------|-----------|
| C7.1 | Admin: click Expos nav | Expo cards render with status chips (LIVE/UPCOMING/COMPLETED) | |
| C7.2 | Click "👥 Referrers" on any expo | Referrer modal opens; shows existing referrers list | |
| C7.3 | In Referrer modal: fill Name + Password → click Create | Success banner shows email + password once; referrer appears in list | |
| C7.4 | Copy email/password using copy buttons | Clipboard notification appears | |
| C7.5 | Click Delete on a referrer | Referrer removed from list | |
| C7.6 | Create expo with future start date | Status shows "UPCOMING" | |
| C7.7 | Create expo with past end date | Status shows "COMPLETED" | |
| C7.8 | Log in as a referrer user | Sees lead-capture form only; Admin UI is hidden | |
| C7.9 | Referrer submits the lead form | Toast: "Lead captured!"; counter increments | |

---

### C8 — Analytics

| # | Steps | Expected Result | Pass/Fail |
|---|-------|----------------|-----------|
| C8.1 | Admin: click Analytics nav | Three charts render: Main Bar, Product Interest, Lost Reasons | |
| C8.2 | Navigate back to Overview | KPI cards animate their numbers from 0 | |
| C8.3 | Click "EXPO" tab on Funnel chart | Funnel filters to expo-source leads only | |
| C8.4 | Click "Month" / "Quarter" on Leaderboard | Leaderboard re-sorts (UI state change only) | |

---

### C9 — Keyboard Shortcuts (Admin)

| Shortcut | Expected Action |
|----------|----------------|
| `1` | Go to Overview |
| `2` | Go to Leads |
| `3` | Go to Agents |
| `4` | Go to Products |
| `5` | Go to Expos |
| `6` | Go to Analytics |
| `N` or `n` | Open New Lead modal |
| `Esc` | Close any open modal |

---

### C10 — Security / RBAC Spot Checks

| # | Steps | Expected Result | Pass/Fail |
|---|-------|----------------|-----------|
| C10.1 | Open devtools → manually call `fetch('/api/settings', {method:'PUT', headers:{'Authorization':'Bearer fake.token','Content-Type':'application/json'}, body:JSON.stringify({updates:{'company.name':'Hacked'}})})` | 401 Unauthorized |  |
| C10.2 | Log in as Manager → open console → `fetch('/api/settings', {method:'PUT', headers:{'Authorization':'Bearer '+localStorage.ii_token,'Content-Type':'application/json'}, body:JSON.stringify({updates:{'company.name':'Hacked'}})})` | 403 Forbidden | |
| C10.3 | Log in as Agent → manually `fetch('/api/leads/bulk', ...)` via console | 403 Forbidden | |
| C10.4 | Call `GET /api/auth/me` without token | 401 Unauthorized | |

---

## Part D — Smoke Test After Deployment

Run these after every deploy to production:

```bash
# Health check
curl -s https://iinvsys-sales.vercel.app/api/health | python3 -m json.tool

# Login smoke test
curl -s -X POST https://iinvsys-sales.vercel.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@iinvsys.com","password":"Admin@123"}' | python3 -m json.tool

# Settings shape check (requires token from above)
TOKEN="<paste token here>"
curl -s https://iinvsys-sales.vercel.app/api/settings \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | grep -E '"settings"|"map"'

# Bulk import route exists
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://iinvsys-sales.vercel.app/api/leads/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"leads":[]}'
# Expected: 400 (not 404)
```

---

## Part E — Known Limitations & Remaining Notes

| Area | Note |
|------|------|
| Rate limiter on login | Login endpoint is limited to 20 req / 15 min. The test suites for auth, leads, agents, products use the actual login endpoint — if > 20 login calls are made within one test run they will hit 429. Always use `npm test` (`--runInBand`) and avoid running suites concurrently. |
| Reset Creds button | `resetCreds()` in `app.js` only shows a flash toast — it does **not** make an API call. Password reset email delivery is not implemented. |
| Expo action buttons | "Live Dashboard", "QR Mode", "Edit Event", "Assign Agents", "Report", "Compare" buttons in expo cards are UI stubs — they have no click handlers wired up. |
| Activity Stream | The Activity Stream on the Overview page shows hardcoded seed data, not live events from MongoDB. |
| Analytics charts | Monthly/quarterly trend data in the Analytics page is partially hardcoded (historical data) with only the current-month figure taken from the live database. |
| CSV with commas in fields | The CSV parser does not handle RFC 4180 quoted commas (e.g. `"Smith, John"` in the name column). Such rows will be split incorrectly. |
| Hard delete + linked leads | `hardDeleteAgent` unassigns leads but does not delete them. Verify this is the intended behaviour. |

---

*Guide maintained by the IINVSYS Engineering team — last updated 2026-04-02*
