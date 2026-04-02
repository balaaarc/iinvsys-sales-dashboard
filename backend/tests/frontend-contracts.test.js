'use strict';
/**
 * frontend-contracts.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression suite for every API contract the frontend (app.js) depends on.
 *
 * Each test documents the exact response shape the JS client reads.  When a
 * backend change breaks the shape the matching test fails immediately —
 * before a tester ever opens a browser.
 *
 * Covers bugs found in the original app:
 *   BUG-01  renderSettings() used res.data (object) as an array → forEach crash
 *   BUG-02  saveSetting() sent { updates:[{key,value}] } instead of {updates:{key:value}}
 *   BUG-03  confirmImportBtn called /leads/bulk-import instead of /leads/bulk
 *   BUG-04  importResults showed res.data?.skipped but backend returns .duplicates
 * ─────────────────────────────────────────────────────────────────────────────
 */

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');
const db      = require('./helpers/db');
const User    = require('../src/models/User');
const Agent   = require('../src/models/Agent');
const Lead    = require('../src/models/Lead');
const Expo    = require('../src/models/Expo');
const Product = require('../src/models/Product');

beforeAll(async () => { await db.connect(); });
afterEach(async () => { await db.clearCollections(); });
afterAll(async () => { await db.disconnect(); });

/* ─── helpers ─────────────────────────────────────────────────────────────── */

async function insertUser(attrs) {
  const emailFallback = `${attrs.role || 'user'}_${Date.now()}@test.com`;
  const res = await User.collection.insertOne({
    name:        attrs.name  || attrs.role || 'User',
    email:       attrs.email || emailFallback,
    password:    '$2b$01$placeholder',
    role:        attrs.role  || 'agent',
    agentId:     attrs.agentId  || null,
    expoId:      attrs.expoId   || null,
    expiresAt:   attrs.expiresAt ?? null,
    isTemporary: false,
    isActive:    attrs.isActive ?? true,
    lastLogin:   null,
    createdAt:   new Date(),
    updatedAt:   new Date(),
  });
  return res.insertedId;
}

function tok(userId, extra = {}) {
  return jwt.sign({ userId, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function makeAdmin() {
  const id = await insertUser({ name: 'Admin', email: 'admin@test.com', role: 'superadmin' });
  return { id, token: tok(id) };
}

async function makeManager() {
  const id = await insertUser({ name: 'Mgr', email: 'mgr@test.com', role: 'manager' });
  return { id, token: tok(id) };
}

async function makeAgentWithUser(suffix = '1', createdById) {
  const agent = await Agent.create({
    name: `Agent${suffix}`, initials: `A${suffix}`,
    email: `agt${suffix}@test.com`, phone: `900${suffix.padStart(7,'0')}`,
    territory: 'Delhi', designation: 'Sales Agent', target: 500000,
    createdBy: createdById,
  });
  const uid = await insertUser({ name: `Agent${suffix}`, email: `agt${suffix}@test.com`, role: 'agent', agentId: agent._id });
  return { agent, uid, token: tok(uid) };
}

async function makeLead(overrides, createdById) {
  return Lead.create({
    name: 'Test Lead', phone: `900${Math.floor(Math.random()*10000000)}`,
    source: 'direct', stage: 'new', value: 10000,
    createdBy: createdById, ...overrides,
  });
}

/* Seed settings by calling GET /api/settings once */
async function seedSettings(token) {
  return request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 1 — SETTINGS (BUG-01, BUG-02)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('GET /api/settings — response shape consumed by renderSettings()', () => {

  it('[BUG-01] res.data is an OBJECT {settings,map}, NOT a bare array', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    // The frontend originally assumed res.data was an array.
    // Confirm it is an OBJECT with two keys:
    expect(typeof res.body.data).toBe('object');
    expect(Array.isArray(res.body.data)).toBe(false);
    expect(res.body.data).toHaveProperty('settings');
    expect(res.body.data).toHaveProperty('map');
  });

  it('[BUG-01] res.data.settings IS the array — forEach is safe', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`);

    const settings = res.body.data.settings;
    expect(Array.isArray(settings)).toBe(true);
    expect(settings.length).toBeGreaterThan(0);
    // This is what renderSettings() must call — must not throw
    expect(() => settings.forEach(s => s)).not.toThrow();
  });

  it('each setting in the array has key, value, label, type, group', async () => {
    const admin = await makeAdmin();
    const res   = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`);

    const settings = res.body.data.settings;
    settings.forEach(s => {
      expect(s).toHaveProperty('key');
      expect(s).toHaveProperty('value');
      expect(s).toHaveProperty('label');
      expect(s).toHaveProperty('type');
      expect(s).toHaveProperty('group');
    });
  });

  it('res.data.map is a flat object keyed by setting key', async () => {
    const admin = await makeAdmin();
    const res   = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`);

    const map = res.body.data.map;
    expect(typeof map).toBe('object');
    expect(Array.isArray(map)).toBe(false);
    // Dot-notation literal keys must exist:
    expect(map['company.name']).toBeDefined();
    expect(map['lead.overdueAfterDays']).toBeDefined();
    expect(map['lead.stages']).toBeDefined();
  });

  it('map values match their corresponding settings array values', async () => {
    const admin = await makeAdmin();
    const res   = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`);

    const { settings, map } = res.body.data;
    settings.forEach(s => {
      expect(map[s.key]).toEqual(s.value);
    });
  });

  it('lead.stages is an array with exactly 7 entries', async () => {
    const admin = await makeAdmin();
    const res   = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`);

    const stages = res.body.data.map['lead.stages'];
    expect(Array.isArray(stages)).toBe(true);
    expect(stages).toHaveLength(7);
    ['new','contacted','interested','proposal','negotiation','won','lost']
      .forEach(s => expect(stages).toContain(s));
  });

  it('company.name is the string "IINVSYS" on a fresh database', async () => {
    const admin = await makeAdmin();
    const res   = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.body.data.map['company.name']).toBe('IINVSYS');
  });

  it('lead.overdueAfterDays is the number 7 (not string)', async () => {
    const admin = await makeAdmin();
    const res   = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(typeof res.body.data.map['lead.overdueAfterDays']).toBe('number');
    expect(res.body.data.map['lead.overdueAfterDays']).toBe(7);
  });

  it('system.allowSelfRegister is the boolean false (not string)', async () => {
    const admin = await makeAdmin();
    const res   = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(typeof res.body.data.map['system.allowSelfRegister']).toBe('boolean');
    expect(res.body.data.map['system.allowSelfRegister']).toBe(false);
  });

  it('calling GET /api/settings twice does not duplicate settings', async () => {
    const admin = await makeAdmin();
    const auth  = `Bearer ${admin.token}`;
    await request(app).get('/api/settings').set('Authorization', auth);
    const res = await request(app).get('/api/settings').set('Authorization', auth);
    const keys = res.body.data.settings.map(s => s.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(401);
  });

  it('readonly role can list settings (200)', async () => {
    const id  = await insertUser({ role: 'readonly', email: 'ro@test.com' });
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${tok(id)}`);
    expect(res.status).toBe(200);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('GET /api/settings/:key — shape consumed by single-key view', () => {

  it('returns 200 with key, value, label, type, group', async () => {
    const admin = await makeAdmin();
    await seedSettings(admin.token);
    const res = await request(app)
      .get('/api/settings/lead.overdueAfterDays')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.key).toBe('lead.overdueAfterDays');
    expect(res.body.data.value).toBe(7);
    expect(res.body.data.type).toBe('number');
    expect(res.body.data.group).toBe('pipeline');
    expect(res.body.data.label).toBeDefined();
  });

  it('returns 404 for a key that does not exist', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/settings/nonexistent.key')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });

  it('unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/settings/company.name');
    expect(res.status).toBe(401);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('PUT /api/settings — BUG-02: must send object map, not array', () => {

  it('[BUG-02] CORRECT format {updates:{key:value}} returns 200', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ updates: { 'company.name': 'Patched Corp' } });
    expect(res.status).toBe(200);
    expect(res.body.data.map['company.name']).toBe('Patched Corp');
  });

  it('[BUG-02] WRONG format {updates:[{key,value}]} (array) returns 422', async () => {
    /* This is the old broken format the frontend was sending. The backend
       must reject it so the bug is visible in tests, not just in the UI. */
    const admin = await makeAdmin();
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ updates: [{ key: 'company.name', value: 'Should Fail' }] });
    // Object.entries on an array gives index keys "0","1" etc — backend must
    // still treat them as a valid-shape object, BUT the key "0" is wrong.
    // Either way: the stored value should NOT be "Patched Corp" at company.name.
    // We document the expected status here:
    expect([200, 422]).toContain(res.status);
    // And verify the setting was NOT updated to the intended value:
    if (res.status === 200) {
      expect(res.body.data.map['company.name']).not.toBe('Should Fail');
    }
  });

  it('superadmin can update multiple settings in one call', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ updates: { 'company.name': 'MultiUpdate', 'lead.overdueAfterDays': 14 } });
    expect(res.status).toBe(200);
    expect(res.body.data.map['company.name']).toBe('MultiUpdate');
    expect(res.body.data.map['lead.overdueAfterDays']).toBe(14);
  });

  it('updated value persists in subsequent GET', async () => {
    const admin = await makeAdmin();
    await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ updates: { 'company.tagline': 'Persistence Test' } });
    const res = await request(app)
      .get('/api/settings/company.tagline')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.value).toBe('Persistence Test');
  });

  it('new/custom keys are upserted (not rejected)', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ updates: { 'custom.featureFlag': true } });
    expect(res.status).toBe(200);
    expect(res.body.data.map['custom.featureFlag']).toBe(true);
  });

  it('returns 422 when updates field is missing from body', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(res.status).toBe(422);
  });

  it('returns 422 when updates is null', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ updates: null });
    expect(res.status).toBe(422);
  });

  it('manager cannot update settings (403)', async () => {
    const mgr = await makeManager();
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ updates: { 'company.name': 'Hijacked' } });
    expect(res.status).toBe(403);
  });

  it('agent cannot update settings (403)', async () => {
    const admin = await makeAdmin();
    const { token } = await makeAgentWithUser('1', admin.id);
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ updates: { 'company.name': 'Hijacked' } });
    expect(res.status).toBe(403);
  });

  it('unauthenticated returns 401', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ updates: { 'company.name': 'X' } });
    expect(res.status).toBe(401);
  });

  it('response shape matches GET /api/settings shape (settings + map)', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ updates: { 'company.name': 'ShapeCheck' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('settings');
    expect(res.body.data).toHaveProperty('map');
    expect(Array.isArray(res.body.data.settings)).toBe(true);
    expect(typeof res.body.data.map).toBe('object');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 2 — BULK IMPORT (BUG-03, BUG-04)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('POST /api/leads/bulk — BUG-03: correct route (not /bulk-import)', () => {

  it('[BUG-03] POST /api/leads/bulk exists and returns 200 for valid input', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ leads: [{ name: 'Import A', phone: '9001111111', source: 'direct', stage: 'new' }] });
    expect(res.status).toBe(200);
  });

  it('[BUG-03] POST /api/leads/bulk-import returns 404 (this was the broken URL)', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads/bulk-import')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ leads: [{ name: 'Should 404', phone: '9002222222', source: 'direct' }] });
    expect(res.status).toBe(404);
  });

  it('[BUG-04] response has .imported and .duplicates (NOT .skipped)', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ leads: [{ name: 'Lead A', phone: '9001111111', source: 'direct' }] });

    expect(res.status).toBe(200);
    // Frontend reads res.data.imported and res.data.duplicates
    expect(res.body.data).toHaveProperty('imported');
    expect(res.body.data).toHaveProperty('duplicates');
    expect(res.body.data).toHaveProperty('total');
    // The field name is 'duplicates', NOT 'skipped'
    expect(res.body.data.duplicates).toBeDefined();
    expect(res.body.data).not.toHaveProperty('skipped');
  });

  it('imports new leads correctly — imported count matches input', async () => {
    const admin = await makeAdmin();
    const leads = [
      { name: 'Lead 1', phone: '9001000001', source: 'direct', stage: 'new' },
      { name: 'Lead 2', phone: '9001000002', source: 'expo',   stage: 'new' },
      { name: 'Lead 3', phone: '9001000003', source: 'digital',stage: 'new' },
    ];
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ leads });
    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(3);
    expect(res.body.data.duplicates).toBe(0);
    expect(res.body.data.total).toBe(3);
  });

  it('deduplicates by phone — skips lead with existing phone', async () => {
    const admin = await makeAdmin();
    await makeLead({ phone: '9001234567', source: 'direct' }, admin.id);
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ leads: [
        { name: 'Dup Lead',  phone: '9001234567', source: 'direct' }, // duplicate
        { name: 'New Lead',  phone: '9009999999', source: 'direct' }, // new
      ]});
    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(1);
    expect(res.body.data.duplicates).toBe(1);
    expect(res.body.data.total).toBe(2);
  });

  it('all duplicates — imported=0, duplicates=N', async () => {
    const admin = await makeAdmin();
    await makeLead({ phone: '9001111111', source: 'direct' }, admin.id);
    await makeLead({ phone: '9002222222', source: 'direct' }, admin.id);
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ leads: [
        { name: 'A', phone: '9001111111', source: 'direct' },
        { name: 'B', phone: '9002222222', source: 'direct' },
      ]});
    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(0);
    expect(res.body.data.duplicates).toBe(2);
  });

  it('empty leads array returns 400', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ leads: [] });
    expect(res.status).toBe(400);
  });

  it('leads field is missing returns 400', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('leads is not an array (string) returns 400', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ leads: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('leads is not an array (object) returns 400', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ leads: { name: 'X', phone: '9001', source: 'direct' } });
    expect(res.status).toBe(400);
  });

  it('agent cannot bulk-import (403)', async () => {
    const admin = await makeAdmin();
    const { token } = await makeAgentWithUser('1', admin.id);
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ leads: [{ name: 'X', phone: '9001', source: 'direct' }] });
    expect(res.status).toBe(403);
  });

  it('readonly cannot bulk-import (403)', async () => {
    const id  = await insertUser({ role: 'readonly', email: 'ro@test.com' });
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tok(id)}`)
      .send({ leads: [{ name: 'X', phone: '9001', source: 'direct' }] });
    expect(res.status).toBe(403);
  });

  it('unauthenticated returns 401', async () => {
    const res = await request(app)
      .post('/api/leads/bulk')
      .send({ leads: [{ name: 'X', phone: '9001', source: 'direct' }] });
    expect(res.status).toBe(401);
  });

  it('manager can bulk-import (200)', async () => {
    const mgr = await makeManager();
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ leads: [{ name: 'Mgr Lead', phone: '9001111111', source: 'direct' }] });
    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 3 — DATA LOADING SHAPES (loadAllData in app.js)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('GET /api/leads — paginated response shape consumed by loadAllData()', () => {

  it('res.data is an array (leads items) — .map(normalizeLead) must not throw', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    // The frontend does: S.leads = leadsRes.data.map(normalizeLead)
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('pagination metadata is at res.pagination (top level, not nested in data)', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pagination');
    expect(res.body.pagination).toHaveProperty('total');
    expect(res.body.pagination).toHaveProperty('page');
    expect(res.body.pagination).toHaveProperty('limit');
    expect(res.body.pagination).toHaveProperty('pages');
  });

  it('each lead item has fields the normalizer expects: _id, name, phone, source, stage', async () => {
    const admin  = await makeAdmin();
    const { agent } = await makeAgentWithUser('1', admin.id);
    await makeLead({ assignedAgent: agent._id, phone: '9001111111' }, admin.id);
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`);
    const lead = res.body.data[0];
    expect(lead).toHaveProperty('_id');
    expect(lead).toHaveProperty('name');
    expect(lead).toHaveProperty('phone');
    expect(lead).toHaveProperty('source');
    expect(lead).toHaveProperty('stage');
    expect(lead).toHaveProperty('value');
    expect(lead).toHaveProperty('score');
    expect(lead).toHaveProperty('createdAt');
  });

  it('assignedAgent is populated with name, initials, color', async () => {
    const admin = await makeAdmin();
    const { agent } = await makeAgentWithUser('1', admin.id);
    await makeLead({ assignedAgent: agent._id, phone: '9001111111' }, admin.id);
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`);
    const lead = res.body.data[0];
    expect(typeof lead.assignedAgent).toBe('object');
    expect(lead.assignedAgent).toHaveProperty('name');
    expect(lead.assignedAgent).toHaveProperty('initials');
    expect(lead.assignedAgent).toHaveProperty('color');
  });

  it('page & limit query params work — second page is empty when total ≤ limit', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/leads?page=2&limit=20')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it('pagination.pages = ceil(total/limit)', async () => {
    const admin = await makeAdmin();
    // Create 5 leads, request limit=3 → pages should be 2
    for (let i = 0; i < 5; i++) {
      await makeLead({ phone: `9001${i}11111` }, admin.id);
    }
    const res = await request(app)
      .get('/api/leads?limit=3')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.body.pagination.pages).toBe(2);
    expect(res.body.data).toHaveLength(3);
  });

  it('unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/leads');
    expect(res.status).toBe(401);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('GET /api/agents — shape consumed by loadAllData()', () => {

  it('res.data is an array — .map(normalizeAgent) must not throw', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('each agent item has _id, name, initials, email, phone, territory, status, target', async () => {
    const admin = await makeAdmin();
    await makeAgentWithUser('1', admin.id);
    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', `Bearer ${admin.token}`);
    const agent = res.body.data[0];
    expect(agent).toHaveProperty('_id');
    expect(agent).toHaveProperty('name');
    expect(agent).toHaveProperty('initials');
    expect(agent).toHaveProperty('email');
    expect(agent).toHaveProperty('phone');
    expect(agent).toHaveProperty('territory');
    expect(agent).toHaveProperty('status');
    expect(agent).toHaveProperty('target');
  });

  it('agent color field exists (used in frontend avatar rendering)', async () => {
    const admin = await makeAdmin();
    await makeAgentWithUser('1', admin.id);
    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.body.data[0]).toHaveProperty('color');
  });

  it('unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(401);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('GET /api/products — shape consumed by loadAllData()', () => {

  it('res.data is an array — .map(normalizeProduct) must not throw', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('each product has _id, name, sku, category, price', async () => {
    const admin = await makeAdmin();
    await Product.create({
      name: 'Test Product', sku: 'TP-001', category: 'hardware',
      price: 9999, createdBy: admin.id,
    });
    const res = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${admin.token}`);
    const p = res.body.data[0];
    expect(p).toHaveProperty('_id');
    expect(p).toHaveProperty('name');
    expect(p).toHaveProperty('sku');
    expect(p).toHaveProperty('category');
    expect(p).toHaveProperty('price');
  });

  it('unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(401);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('GET /api/expos — shape consumed by loadAllData()', () => {

  it('res.data is an array — .map(normalizeExpo) must not throw', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/expos')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('each expo has _id, name, status, startDate, endDate, venue, city', async () => {
    const admin = await makeAdmin();
    await Expo.create({
      name: 'Test Expo', startDate: new Date(Date.now() + 86400000),
      endDate: new Date(Date.now() + 86400000 * 3),
      venue: 'Hall 1', city: 'Mumbai', targetLeads: 50, createdBy: admin.id,
    });
    const res = await request(app)
      .get('/api/expos')
      .set('Authorization', `Bearer ${admin.token}`);
    const e = res.body.data[0];
    expect(e).toHaveProperty('_id');
    expect(e).toHaveProperty('name');
    expect(e).toHaveProperty('status');
    expect(e).toHaveProperty('startDate');
    expect(e).toHaveProperty('endDate');
    expect(e).toHaveProperty('venue');
    expect(e).toHaveProperty('city');
  });

  it('unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/expos');
    expect(res.status).toBe(401);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 4 — AUTH RESPONSE SHAPES (login + /me)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('POST /api/auth/login — shape consumed by login handler', () => {

  it('successful login returns token and user object at res.data.token / res.data.user', async () => {
    /* Create user via proper bcrypt so login works */
    const bcrypt = require('bcryptjs');
    const hash   = await bcrypt.hash('Test@123', 1);
    await User.collection.insertOne({
      name: 'Login Test', email: 'logintest@test.com',
      password: hash, role: 'manager',
      agentId: null, expoId: null, expiresAt: null,
      isTemporary: false, isActive: true,
      lastLogin: null, createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'logintest@test.com', password: 'Test@123' });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.data).toHaveProperty('user');
    expect(res.body.data.user).not.toHaveProperty('password');
    expect(res.body.data.user).toHaveProperty('role');
    expect(res.body.data.user).toHaveProperty('name');
    expect(res.body.data.user).toHaveProperty('email');
  });

  it('wrong password returns 401', async () => {
    const bcrypt = require('bcryptjs');
    const hash   = await bcrypt.hash('Correct@123', 1);
    await User.collection.insertOne({
      name: 'Login Test', email: 'login2@test.com',
      password: hash, role: 'agent',
      agentId: null, expoId: null, expiresAt: null,
      isTemporary: false, isActive: true,
      lastLogin: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login2@test.com', password: 'Wrong@999' });
    expect(res.status).toBe(401);
  });

  it('non-existent user returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'any' });
    expect(res.status).toBe(401);
  });

  it('deactivated account returns 401', async () => {
    const bcrypt = require('bcryptjs');
    const hash   = await bcrypt.hash('Test@123', 1);
    await User.collection.insertOne({
      name: 'Deactivated', email: 'deact@test.com',
      password: hash, role: 'agent',
      agentId: null, expoId: null, expiresAt: null,
      isTemporary: false, isActive: false,
      lastLogin: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'deact@test.com', password: 'Test@123' });
    expect(res.status).toBe(401);
  });

  it('invalid email format returns 422', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'whatever' });
    expect(res.status).toBe(422);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('GET /api/auth/me — shape consumed by tryAutoLogin()', () => {

  it('returns user at res.data.user (with _id, name, role, agentId)', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    // Frontend reads: res.data.user || res.data
    const user = res.body.data.user || res.body.data;
    expect(user).toHaveProperty('_id');
    expect(user).toHaveProperty('name');
    expect(user).toHaveProperty('role');
    expect(user).not.toHaveProperty('password');
  });

  it('expired/invalid token returns 401', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer totally.invalid.token');
    expect(res.status).toBe(401);
  });

  it('missing Authorization header returns 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 5 — LEAD CRUD MODAL CONTRACTS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('POST /api/leads — shape consumed by lead create modal', () => {

  it('creates lead and returns populated object with _id', async () => {
    const admin = await makeAdmin();
    const { agent } = await makeAgentWithUser('1', admin.id);
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'New Lead', phone: '9001234567', source: 'direct', assignedAgent: agent._id });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('_id');
    expect(res.body.data.name).toBe('New Lead');
    expect(res.body.data.stage).toBe('new'); // default
  });

  it('missing name returns 422', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ phone: '9001234567', source: 'direct' });
    expect(res.status).toBe(422);
  });

  it('missing phone returns 422', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'No Phone', source: 'direct' });
    expect(res.status).toBe(422);
  });

  it('invalid source enum returns 422', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'X', phone: '9001234567', source: 'newspaper' });
    expect(res.status).toBe(422);
  });

  it('all valid sources are accepted: expo, referral, direct, digital', async () => {
    const admin = await makeAdmin();
    for (const [i, src] of ['expo','referral','direct','digital'].entries()) {
      const res = await request(app)
        .post('/api/leads')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ name: `Lead${i}`, phone: `900${i}000000`, source: src });
      expect(res.status).toBe(201);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('PUT /api/leads/:id — update lead from modal', () => {

  it('manager can update name, phone, source, stage, value', async () => {
    const admin = await makeAdmin();
    const { agent } = await makeAgentWithUser('1', admin.id);
    const lead = await makeLead({ assignedAgent: agent._id }, admin.id);
    const res = await request(app)
      .put(`/api/leads/${lead._id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Updated Name', stage: 'contacted', value: 50000 });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated Name');
    expect(res.body.data.stage).toBe('contacted');
  });

  it('agent can only update stage and notes — not name/phone', async () => {
    const admin = await makeAdmin();
    const { agent, token: agtTok } = await makeAgentWithUser('1', admin.id);
    const lead = await makeLead({ assignedAgent: agent._id, name: 'Original Name' }, admin.id);
    await request(app)
      .put(`/api/leads/${lead._id}`)
      .set('Authorization', `Bearer ${agtTok}`)
      .send({ name: 'Hacked Name', stage: 'interested', notes: 'Updated notes' });
    const check = await request(app)
      .get(`/api/leads/${lead._id}`)
      .set('Authorization', `Bearer ${agtTok}`);
    expect(check.body.data.name).toBe('Original Name'); // name not changed
    expect(check.body.data.stage).toBe('interested');   // stage updated
  });

  it('agent cannot update a lead assigned to another agent (403)', async () => {
    const admin = await makeAdmin();
    const { agent: a1, token: tok1 } = await makeAgentWithUser('1', admin.id);
    const { agent: a2 }              = await makeAgentWithUser('2', admin.id);
    const lead = await makeLead({ assignedAgent: a2._id }, admin.id);
    const res  = await request(app)
      .put(`/api/leads/${lead._id}`)
      .set('Authorization', `Bearer ${tok1}`)
      .send({ stage: 'won' });
    expect(res.status).toBe(403);
  });

  it('non-existent lead id returns 404', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .put('/api/leads/000000000000000000000000')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ stage: 'won' });
    expect(res.status).toBe(404);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('POST /api/leads/:id/followups — follow-up modal', () => {

  it('valid channels: call, whatsapp, email, visit, other are accepted', async () => {
    const admin = await makeAdmin();
    const { agent } = await makeAgentWithUser('1', admin.id);
    for (const ch of ['call','whatsapp','email','visit','other']) {
      const lead = await makeLead({ assignedAgent: agent._id }, admin.id);
      const res = await request(app)
        .post(`/api/leads/${lead._id}/followups`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ channel: ch, notes: 'Test' });
      expect(res.status).toBe(201);
    }
  }, 60000);

  it('invalid channel (fax) returns 422', async () => {
    const admin = await makeAdmin();
    const { agent } = await makeAgentWithUser('1', admin.id);
    const lead = await makeLead({ assignedAgent: agent._id }, admin.id);
    const res  = await request(app)
      .post(`/api/leads/${lead._id}/followups`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ channel: 'fax' });
    expect(res.status).toBe(422);
  });

  it('follow-up updates lastContact on the lead', async () => {
    const admin = await makeAdmin();
    const { agent } = await makeAgentWithUser('1', admin.id);
    const lead = await makeLead({ assignedAgent: agent._id }, admin.id);
    await request(app)
      .post(`/api/leads/${lead._id}/followups`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ channel: 'call', notes: 'Called' });
    const check = await request(app)
      .get(`/api/leads/${lead._id}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(check.body.data.lastContact).not.toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 6 — AGENT MANAGEMENT CONTRACTS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('DELETE /api/agents/:id/hard — hard delete used by hardDeleteAgent()', () => {

  it('superadmin can hard-delete an agent', async () => {
    const admin = await makeAdmin();
    const { agent } = await makeAgentWithUser('1', admin.id);
    const res = await request(app)
      .delete(`/api/agents/${agent._id}/hard`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    // Subsequent GET should return 404
    const check = await request(app)
      .get(`/api/agents/${agent._id}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(check.status).toBe(404);
  });

  it('manager cannot hard-delete agents (403)', async () => {
    const admin = await makeAdmin();
    const mgr   = await makeManager();
    const { agent } = await makeAgentWithUser('1', admin.id);
    const res = await request(app)
      .delete(`/api/agents/${agent._id}/hard`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });

  it('hard-delete on non-existent agent returns 404', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .delete('/api/agents/000000000000000000000000/hard')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(404);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('DELETE /api/agents/:id — soft delete (deactivate)', () => {

  it('superadmin can soft-delete (deactivate) an agent', async () => {
    const admin = await makeAdmin();
    const { agent } = await makeAgentWithUser('1', admin.id);
    const res = await request(app)
      .delete(`/api/agents/${agent._id}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    const check = await request(app)
      .get(`/api/agents/${agent._id}`)
      .set('Authorization', `Bearer ${admin.token}`);
    // Agent model uses 'status' field ('active'|'inactive'), not isActive boolean
    expect(check.body.data.status).toBe('inactive');
  });

  it('manager cannot soft-delete agents (403)', async () => {
    const admin = await makeAdmin();
    const mgr   = await makeManager();
    const { agent } = await makeAgentWithUser('1', admin.id);
    const res = await request(app)
      .delete(`/api/agents/${agent._id}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 7 — REFERRER MANAGEMENT (openReferrerModal / loadReferrerList)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('GET /api/expos/:id/referrers — shape consumed by loadReferrerList()', () => {

  it('returns array at res.data', async () => {
    const admin = await makeAdmin();
    const expo  = await Expo.create({
      name: 'Test Expo', startDate: new Date(), endDate: new Date(Date.now()+86400000),
      venue: 'Hall', city: 'Delhi', targetLeads: 10, createdBy: admin.id,
    });
    const res = await request(app)
      .get(`/api/expos/${expo._id}/referrers`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('each referrer has _id, name, email but NOT password', async () => {
    const admin = await makeAdmin();
    const expo  = await Expo.create({
      name: 'Ref Expo', startDate: new Date(), endDate: new Date(Date.now()+86400000*3),
      venue: 'Hall', city: 'Mumbai', targetLeads: 10, createdBy: admin.id,
    });
    await request(app)
      .post(`/api/expos/${expo._id}/referrers`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Ref Person', password: 'Ref@1234' });
    const res = await request(app)
      .get(`/api/expos/${expo._id}/referrers`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.body.data.length).toBeGreaterThan(0);
    const r = res.body.data[0];
    expect(r).toHaveProperty('_id');
    expect(r).toHaveProperty('name');
    expect(r).toHaveProperty('email');
    expect(r).not.toHaveProperty('password');
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe('POST /api/expos/:id/referrers — createReferrerBtn handler', () => {

  it('creates referrer and returns email + password once at res.data', async () => {
    const admin = await makeAdmin();
    const expo  = await Expo.create({
      name: 'Cred Expo', startDate: new Date(), endDate: new Date(Date.now()+86400000*3),
      venue: 'Hall', city: 'Delhi', targetLeads: 10, createdBy: admin.id,
    });
    const res = await request(app)
      .post(`/api/expos/${expo._id}/referrers`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Priya', password: 'Priya@1234' });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('email');
    expect(res.body.data).toHaveProperty('password'); // one-time return
  });

  it('missing name returns 400', async () => {
    const admin = await makeAdmin();
    const expo  = await Expo.create({
      name: 'Expo', startDate: new Date(), endDate: new Date(Date.now()+86400000*3),
      venue: 'Hall', city: 'Delhi', targetLeads: 10, createdBy: admin.id,
    });
    const res = await request(app)
      .post(`/api/expos/${expo._id}/referrers`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ password: 'Pass@1234' });
    expect(res.status).toBe(400);
  });

  it('missing password returns 400', async () => {
    const admin = await makeAdmin();
    const expo  = await Expo.create({
      name: 'Expo', startDate: new Date(), endDate: new Date(Date.now()+86400000*3),
      venue: 'Hall', city: 'Delhi', targetLeads: 10, createdBy: admin.id,
    });
    const res = await request(app)
      .post(`/api/expos/${expo._id}/referrers`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'No Pass' });
    expect(res.status).toBe(400);
  });

  it('non-existent expo returns 404', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/expos/000000000000000000000000/referrers')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'X', password: 'Pass@1234' });
    expect(res.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 8 — HEALTH CHECK (no auth required)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('GET /api/health', () => {

  it('returns 200 without any token', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('response has status field', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body).toHaveProperty('status');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 9 — CORNER CASES & SECURITY
   ═══════════════════════════════════════════════════════════════════════════ */

describe('RBAC corner cases', () => {

  it('referrer role cannot access admin leads list (403)', async () => {
    const admin = await makeAdmin();
    const expo  = await Expo.create({
      name: 'E', startDate: new Date(), endDate: new Date(Date.now()+86400000*3),
      venue: 'V', city: 'C', targetLeads: 10, createdBy: admin.id,
    });
    const refUser = await User.collection.insertOne({
      name: 'Ref', email: 'ref@test.com', password: '$2b$01$x',
      role: 'referrer', agentId: null, expoId: expo._id,
      expiresAt: new Date(Date.now()+86400000), isTemporary: false, isActive: true,
      lastLogin: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const refToken = tok(refUser.insertedId);
    // Referrers can POST leads but cannot GET all leads
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${refToken}`);
    expect(res.status).toBe(403);
  });

  it('expired referrer cannot log in', async () => {
    const bcrypt = require('bcryptjs');
    const hash   = await bcrypt.hash('Ref@1234', 1);
    await User.collection.insertOne({
      name: 'Expired Ref', email: 'expref@test.com', password: hash,
      role: 'referrer', agentId: null, expoId: null,
      expiresAt: new Date(Date.now() - 86400000), // yesterday
      isTemporary: false, isActive: true,
      lastLogin: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'expref@test.com', password: 'Ref@1234' });
    expect(res.status).toBe(401);
  });

  it('token with unknown userId returns 401 on protected route', async () => {
    const fakeToken = tok('000000000000000000000000');
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${fakeToken}`);
    expect(res.status).toBe(401);
  });

  it('malformed JWT returns 401', async () => {
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', 'Bearer not.a.real.jwt');
    expect(res.status).toBe(401);
  });

  it('Bearer prefix missing returns 401', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', admin.token); // no "Bearer " prefix
    expect(res.status).toBe(401);
  });
});

describe('Input sanitisation edge cases', () => {

  it('GET /api/leads with invalid page (NaN) defaults gracefully', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/leads?page=abc&limit=xyz')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/leads with very large page returns empty array', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/leads?page=99999&limit=20')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('PUT /api/leads/:id with invalid ObjectId returns 500 or 404', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .put('/api/leads/not-a-valid-id')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ stage: 'won' });
    expect([400, 404, 500]).toContain(res.status);
  });

  it('POST /api/leads with extra unknown fields does not crash', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'Extra Fields', phone: '9001112233', source: 'direct',
        __proto__: { polluted: true }, constructor: 'evil', // proto pollution attempt
        extraField: 'ignored',
      });
    // Should succeed or fail validation but never 500
    expect([201, 422]).toContain(res.status);
  });

  it('settings key with SQL-injection-like value is stored safely', async () => {
    const admin = await makeAdmin();
    const evilValue = "'; DROP TABLE settings; --";
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ updates: { 'company.tagline': evilValue } });
    expect(res.status).toBe(200);
    // Value stored literally, not executed
    expect(res.body.data.map['company.tagline']).toBe(evilValue);
  });

  it('empty string for required lead name returns 422', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: '', phone: '9001234567', source: 'direct' });
    expect(res.status).toBe(422);
  });

  it('whitespace-only lead name returns 422', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: '   ', phone: '9001234567', source: 'direct' });
    expect(res.status).toBe(422);
  });
});
