'use strict';
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');
const db      = require('./helpers/db');
const User    = require('../src/models/User');
const Agent   = require('../src/models/Agent');
const Lead    = require('../src/models/Lead');
const Expo    = require('../src/models/Expo');

beforeAll(async () => { await db.connect(); });
afterEach(async () => { await db.clearCollections(); });
afterAll(async () => { await db.disconnect(); });

/* ─── helpers ─────────────────────────────────────────────────── */

async function insertUser(attrs) {
  const result = await User.collection.insertOne({
    name: attrs.name || 'User', email: attrs.email || 'u@t.com',
    password: '$2b$01$placeholder',
    role: attrs.role || 'agent', agentId: attrs.agentId || null,
    expoId: null, expiresAt: null, isTemporary: false, isActive: true,
    lastLogin: null, createdAt: new Date(), updatedAt: new Date(),
  });
  return result.insertedId;
}

function makeToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function createAdmin() {
  const id = await insertUser({ name: 'Admin', email: 'admin@test.com', role: 'superadmin' });
  return { _id: id, token: makeToken(id) };
}

async function createAgentWithUser(mgrId, suffix = '1') {
  const agent = await Agent.create({
    name: `Agent${suffix}`, initials: `A${suffix}`, email: `agent${suffix}@t.com`,
    phone: `900000000${suffix}`, territory: 'Delhi', designation: 'Sales Agent',
    target: 1000000, createdBy: mgrId,
  });
  const uid = await insertUser({ name: `Agent${suffix}`, email: `agent${suffix}@t.com`, role: 'agent', agentId: agent._id });
  return { agent, token: makeToken(uid) };
}

async function createLead(overrides, createdById) {
  return Lead.create({
    name: 'Test Lead', phone: '9000000000', source: 'direct',
    stage: 'new', value: 10000, createdBy: createdById,
    ...overrides,
  });
}

async function createExpo(createdById, overrides = {}) {
  const past  = new Date(Date.now() - 86400000 * 10);
  const past2 = new Date(Date.now() - 86400000 * 3);
  return Expo.create({
    name: 'Test Expo', startDate: past, endDate: past2,
    venue: 'Hall 1', city: 'Delhi', targetLeads: 50,
    createdBy: createdById, ...overrides,
  });
}

/* ─── GET /api/analytics/overview ────────────────────────────── */

describe('GET /api/analytics/overview', () => {
  it('returns 401 without auth token', async () => {
    const res = await request(app).get('/api/analytics/overview');
    expect(res.status).toBe(401);
  });

  it('returns correct KPI structure when no leads exist', async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .get('/api/analytics/overview')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('kpi');
    expect(res.body.data.kpi).toMatchObject({
      totalLeads: 0, activeLeads: 0, wonLeads: 0, lostLeads: 0,
      pipeline: 0, wonRevenue: 0, conversionRate: 0,
    });
    expect(res.body.data).toHaveProperty('stageBreakdown');
    expect(res.body.data).toHaveProperty('sourceBreakdown');
    expect(res.body.data).toHaveProperty('topAgents');
    expect(res.body.data).toHaveProperty('recentLeads');
  });

  it('calculates totalLeads, wonLeads, lostLeads correctly', async () => {
    const admin = await createAdmin();
    const { agent } = await createAgentWithUser(admin._id, '1');

    await createLead({ assignedAgent: agent._id, stage: 'won',       value: 50000, phone: '9001' }, admin._id);
    await createLead({ assignedAgent: agent._id, stage: 'lost',      value: 20000, phone: '9002' }, admin._id);
    await createLead({ assignedAgent: agent._id, stage: 'new',       value: 10000, phone: '9003' }, admin._id);
    await createLead({ assignedAgent: agent._id, stage: 'contacted', value: 8000,  phone: '9004' }, admin._id);

    const res = await request(app)
      .get('/api/analytics/overview')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    const kpi = res.body.data.kpi;
    expect(kpi.totalLeads).toBe(4);
    expect(kpi.wonLeads).toBe(1);
    expect(kpi.lostLeads).toBe(1);
    expect(kpi.activeLeads).toBe(2);
    expect(kpi.wonRevenue).toBe(50000);
    expect(kpi.conversionRate).toBe(25);
  });

  it('calculates pipeline as sum of all lead values', async () => {
    const admin = await createAdmin();
    const { agent } = await createAgentWithUser(admin._id, '1');

    await createLead({ assignedAgent: agent._id, stage: 'proposal',    value: 30000, phone: '9011' }, admin._id);
    await createLead({ assignedAgent: agent._id, stage: 'negotiation', value: 40000, phone: '9012' }, admin._id);
    await createLead({ assignedAgent: agent._id, stage: 'new',         value: 10000, phone: '9013' }, admin._id);

    const res = await request(app)
      .get('/api/analytics/overview')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.body.data.kpi.pipeline).toBe(80000);
  });

  it('agent scope: agent only sees own leads in overview', async () => {
    const admin = await createAdmin();
    const { agent: a1, token: agt1Token } = await createAgentWithUser(admin._id, '1');
    const { agent: a2 }                   = await createAgentWithUser(admin._id, '2');

    await createLead({ assignedAgent: a1._id, stage: 'won', value: 50000, phone: '9021' }, admin._id);
    await createLead({ assignedAgent: a2._id, stage: 'won', value: 70000, phone: '9022' }, admin._id);

    const res = await request(app)
      .get('/api/analytics/overview')
      .set('Authorization', `Bearer ${agt1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.kpi.totalLeads).toBe(1);
    expect(res.body.data.kpi.wonRevenue).toBe(50000);
  });

  it('stageBreakdown contains correct stage entries', async () => {
    const admin = await createAdmin();
    const { agent } = await createAgentWithUser(admin._id, '1');

    await createLead({ assignedAgent: agent._id, stage: 'won',  phone: '9031', value: 1000 }, admin._id);
    await createLead({ assignedAgent: agent._id, stage: 'won',  phone: '9032', value: 2000 }, admin._id);
    await createLead({ assignedAgent: agent._id, stage: 'lost', phone: '9033', value: 0    }, admin._id);

    const res = await request(app)
      .get('/api/analytics/overview')
      .set('Authorization', `Bearer ${admin.token}`);

    const wonStage = res.body.data.stageBreakdown.find(s => s._id === 'won');
    expect(wonStage).toBeDefined();
    expect(wonStage.count).toBe(2);
    expect(wonStage.value).toBe(3000);
  });

  it('topAgents is populated with agent details', async () => {
    const admin = await createAdmin();
    const { agent } = await createAgentWithUser(admin._id, '1');

    await createLead({ assignedAgent: agent._id, stage: 'won', phone: '9041' }, admin._id);

    const res = await request(app)
      .get('/api/analytics/overview')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.body.data.topAgents.length).toBeGreaterThan(0);
    expect(res.body.data.topAgents[0]).toHaveProperty('wonCount');
    expect(res.body.data.topAgents[0].agent).toHaveProperty('name');
  });

  it('recentLeads returns at most 5 leads sorted by newest', async () => {
    const admin = await createAdmin();
    const { agent } = await createAgentWithUser(admin._id, '1');

    for (let i = 1; i <= 8; i++) {
      await createLead({ assignedAgent: agent._id, phone: `90${i}0`, name: `Lead${i}` }, admin._id);
    }

    const res = await request(app)
      .get('/api/analytics/overview')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.body.data.recentLeads.length).toBe(5);
  });

  it('conversionRate is 0 when no leads exist', async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .get('/api/analytics/overview')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.body.data.kpi.conversionRate).toBe(0);
  });
});

/* ─── GET /api/analytics/trends ──────────────────────────────── */

describe('GET /api/analytics/trends', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/analytics/trends');
    expect(res.status).toBe(401);
  });

  it('returns monthly and scoreDist arrays', async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .get('/api/analytics/trends')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('monthly');
    expect(res.body.data).toHaveProperty('scoreDist');
    expect(Array.isArray(res.body.data.monthly)).toBe(true);
    expect(Array.isArray(res.body.data.scoreDist)).toBe(true);
  });

  it('monthly includes current month entry after creating a lead', async () => {
    const admin = await createAdmin();
    const { agent } = await createAgentWithUser(admin._id, '1');

    await createLead({ assignedAgent: agent._id, phone: '9051', value: 15000 }, admin._id);

    const res = await request(app)
      .get('/api/analytics/trends')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    const now = new Date();
    const month = res.body.data.monthly.find(
      m => m._id.month === now.getMonth() + 1 && m._id.year === now.getFullYear()
    );
    expect(month).toBeDefined();
    expect(month.count).toBe(1);
    expect(month.value).toBe(15000);
  });

  it('scoreDist buckets leads by score range', async () => {
    const admin = await createAdmin();
    const { agent } = await createAgentWithUser(admin._id, '1');

    await createLead({ assignedAgent: agent._id, phone: '9061', score: 10 }, admin._id); // 0-20
    await createLead({ assignedAgent: agent._id, phone: '9062', score: 30 }, admin._id); // 21-40
    await createLead({ assignedAgent: agent._id, phone: '9063', score: 75 }, admin._id); // 61-80
    await createLead({ assignedAgent: agent._id, phone: '9064', score: 95 }, admin._id); // 81-100

    const res = await request(app)
      .get('/api/analytics/trends')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    const buckets = res.body.data.scoreDist;
    expect(buckets.length).toBeGreaterThan(0);
    const lowBucket  = buckets.find(b => b._id === 0);
    const medBucket  = buckets.find(b => b._id === 21);
    const highBucket = buckets.find(b => b._id === 81);
    expect(lowBucket?.count).toBe(1);
    expect(medBucket?.count).toBe(1);
    expect(highBucket?.count).toBe(1);
  });

  it('agent scope restricts monthly data to own leads', async () => {
    const admin = await createAdmin();
    const { agent: a1, token: agt1Token } = await createAgentWithUser(admin._id, '1');
    const { agent: a2 }                   = await createAgentWithUser(admin._id, '2');

    await createLead({ assignedAgent: a1._id, phone: '9071', value: 5000 }, admin._id);
    await createLead({ assignedAgent: a2._id, phone: '9072', value: 9000 }, admin._id);

    const res = await request(app)
      .get('/api/analytics/trends')
      .set('Authorization', `Bearer ${agt1Token}`);

    expect(res.status).toBe(200);
    const total = res.body.data.monthly.reduce((s, m) => s + m.count, 0);
    expect(total).toBe(1);
  });
});

/* ─── GET /api/analytics/expos ───────────────────────────────── */

describe('GET /api/analytics/expos', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/analytics/expos');
    expect(res.status).toBe(401);
  });

  it('returns empty array when no expos exist', async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .get('/api/analytics/expos')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns expo with correct leadCount and wonCount', async () => {
    const admin = await createAdmin();
    const { agent } = await createAgentWithUser(admin._id, '1');
    const expo = await createExpo(admin._id);

    await createLead({ assignedAgent: agent._id, expo: expo._id, stage: 'won',  value: 30000, phone: '9081' }, admin._id);
    await createLead({ assignedAgent: agent._id, expo: expo._id, stage: 'lost', value: 0,     phone: '9082' }, admin._id);
    await createLead({ assignedAgent: agent._id, expo: expo._id, stage: 'new',  value: 0,     phone: '9083' }, admin._id);

    const res = await request(app)
      .get('/api/analytics/expos')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    const expoData = res.body.data.find(e => e._id === expo._id.toString());
    expect(expoData).toBeDefined();
    expect(expoData.leadCount).toBe(3);
    expect(expoData.wonCount).toBe(1);
    expect(expoData.wonValue).toBe(30000);
  });

  it('calculates roiPercent correctly against targetLeads', async () => {
    const admin = await createAdmin();
    const { agent } = await createAgentWithUser(admin._id, '1');
    const expo = await createExpo(admin._id, { targetLeads: 50 });

    for (let i = 0; i < 25; i++) {
      await createLead({ assignedAgent: agent._id, expo: expo._id, phone: `80${String(i).padStart(2, '0')}` }, admin._id);
    }

    const res = await request(app)
      .get('/api/analytics/expos')
      .set('Authorization', `Bearer ${admin.token}`);

    const expoData = res.body.data.find(e => e._id === expo._id.toString());
    expect(expoData.roiPercent).toBe(50);
  });

  it('roiPercent is 0 when targetLeads is 0', async () => {
    const admin = await createAdmin();
    const { agent } = await createAgentWithUser(admin._id, '1');
    const expo = await createExpo(admin._id, { targetLeads: 0 });

    await createLead({ assignedAgent: agent._id, expo: expo._id, phone: '9091' }, admin._id);

    const res = await request(app)
      .get('/api/analytics/expos')
      .set('Authorization', `Bearer ${admin.token}`);

    const expoData = res.body.data.find(e => e._id === expo._id.toString());
    expect(expoData.roiPercent).toBe(0);
  });
});
