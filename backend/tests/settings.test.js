'use strict';
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');
const db      = require('./helpers/db');
const User    = require('../src/models/User');

beforeAll(async () => { await db.connect(); });
afterEach(async () => { await db.clearCollections(); });
afterAll(async () => { await db.disconnect(); });

/* ─── helpers ─────────────────────────────────────────────────── */

async function tokenFor(role) {
  const emailMap = {
    superadmin: 'admin@test.com', manager: 'mgr@test.com',
    readonly: 'ro@test.com', agent: 'agt@test.com',
  };
  const result = await User.collection.insertOne({
    name: role, email: emailMap[role],
    password: '$2b$01$placeholder',
    role, agentId: null, expoId: null, expiresAt: null,
    isTemporary: false, isActive: true,
    lastLogin: null, createdAt: new Date(), updatedAt: new Date(),
  });
  return jwt.sign({ userId: result.insertedId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

/* ─── GET /api/settings ──────────────────────────────────────── */

describe('GET /api/settings', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(401);
  });

  it('readonly can list settings', async () => {
    const token = await tokenFor('readonly');
    const res   = await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('settings');
    expect(res.body.data).toHaveProperty('map');
  });

  it('seeds default settings on first call', async () => {
    const token = await tokenFor('readonly');
    const res   = await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.settings.length).toBeGreaterThan(0);

    const map = res.body.data.map;
    expect(map['company.name']).toBe('IINVSYS');
    expect(map['company.currency']).toBe('₹');
    expect(map['lead.overdueAfterDays']).toBe(7);
    expect(map['system.allowSelfRegister']).toBe(false);
  });

  it('returns flat map for easy consumption', async () => {
    const token = await tokenFor('readonly');
    const res   = await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);

    const map = res.body.data.map;
    expect(typeof map).toBe('object');
    expect(map['company.name']).toBeDefined();
    expect(map['lead.stages']).toBeDefined();
    expect(Array.isArray(map['lead.stages'])).toBe(true);
  });

  it('does not re-seed defaults if settings already exist', async () => {
    const token = await tokenFor('readonly');

    await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);
    const res2 = await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);

    const keys      = res2.body.data.settings.map(s => s.key);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });

  it('lead.stages contains all expected pipeline stages', async () => {
    const token  = await tokenFor('readonly');
    const res    = await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);
    const stages = res.body.data.map['lead.stages'];

    ['new','contacted','interested','proposal','negotiation','won','lost']
      .forEach(s => expect(stages).toContain(s));
  });

  it('product.categories contains expected values', async () => {
    const token = await tokenFor('readonly');
    const res   = await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);
    const cats  = res.body.data.map['product.categories'];

    ['hardware','software','service','bundle'].forEach(c => expect(cats).toContain(c));
  });
});

/* ─── GET /api/settings/:key ─────────────────────────────────── */

describe('GET /api/settings/:key', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/settings/company.name');
    expect(res.status).toBe(401);
  });

  it('returns single setting by key', async () => {
    const token = await tokenFor('readonly');

    await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .get('/api/settings/company.name')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.key).toBe('company.name');
    expect(res.body.data.value).toBe('IINVSYS');
  });

  it('returns 404 for non-existent key', async () => {
    const token = await tokenFor('readonly');
    const res   = await request(app)
      .get('/api/settings/nonexistent.key')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns setting with all metadata fields', async () => {
    const token = await tokenFor('readonly');

    await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .get('/api/settings/lead.overdueAfterDays')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('key');
    expect(res.body.data).toHaveProperty('value');
    expect(res.body.data).toHaveProperty('label');
    expect(res.body.data).toHaveProperty('type');
    expect(res.body.data).toHaveProperty('group');
    expect(res.body.data.type).toBe('number');
    expect(res.body.data.group).toBe('pipeline');
  });
});

/* ─── PUT /api/settings ──────────────────────────────────────── */

describe('PUT /api/settings', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ updates: { 'company.name': 'NewName' } });
    expect(res.status).toBe(401);
  });

  it('superadmin can update settings', async () => {
    const token = await tokenFor('superadmin');

    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ updates: { 'company.name': 'Updated Corp', 'lead.overdueAfterDays': 14 } });

    expect(res.status).toBe(200);
    expect(res.body.data.map['company.name']).toBe('Updated Corp');
    expect(res.body.data.map['lead.overdueAfterDays']).toBe(14);
  });

  it('non-superadmin cannot update settings', async () => {
    const token = await tokenFor('manager');

    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ updates: { 'company.name': 'Hacked' } });

    expect(res.status).toBe(403);
  });

  it('returns 422 when updates object is missing', async () => {
    const token = await tokenFor('superadmin');

    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(422);
  });

  it('upserts new setting keys not in defaults', async () => {
    const token = await tokenFor('superadmin');

    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ updates: { 'custom.featureFlag': true } });

    expect(res.status).toBe(200);
    expect(res.body.data.map['custom.featureFlag']).toBe(true);
  });

  it('updated settings persist across requests', async () => {
    const token = await tokenFor('superadmin');

    await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ updates: { 'company.tagline': 'New Tagline' } });

    await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .get('/api/settings/company.tagline')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.value).toBe('New Tagline');
  });

  it('agent cannot update settings', async () => {
    const token = await tokenFor('agent');

    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ updates: { 'company.name': 'Test' } });

    expect(res.status).toBe(403);
  });
});
