'use strict';
/**
 * lead-filters.test.js
 * Tests: filtering, pagination, GET by ID, DELETE, model virtuals,
 *        validation edge cases, bulk import, follow-up channels.
 *
 * Uses collection.insertOne() to bypass bcrypt pre-save hook and
 * jwt.sign() to bypass the login endpoint (which has a rate-limit of
 * 20 req/15 min that would be exceeded by this many tests).
 */
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

async function setupBase() {
  const mgrId = await insertUser({ name: 'Mgr', email: 'mgr@t.com', role: 'manager' });

  const agent1 = await Agent.create({
    name: 'Agent1', initials: 'A1', email: 'agt1@t.com',
    phone: '9001111111', territory: 'Delhi', designation: 'Sales Agent', createdBy: mgrId,
  });
  const agt1Id = await insertUser({ name: 'Agent1', email: 'agt1@t.com', role: 'agent', agentId: agent1._id });

  const agent2 = await Agent.create({
    name: 'Agent2', initials: 'A2', email: 'agt2@t.com',
    phone: '9002222222', territory: 'Mumbai', designation: 'Sales Agent', createdBy: mgrId,
  });
  await insertUser({ name: 'Agent2', email: 'agt2@t.com', role: 'agent', agentId: agent2._id });

  return {
    mgrId,   mgrToken:  makeToken(mgrId),
    agent1,  agt1Token: makeToken(agt1Id),
    agent2,
  };
}

/* ─── Filter: by stage ────────────────────────────────────────── */

describe('GET /api/leads - filter by stage', () => {
  it('returns only leads in the requested stage', async () => {
    const { agent1, mgrToken } = await setupBase();

    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Won Lead',  phone: '9100', source: 'direct', assignedAgent: agent1._id, stage: 'won' });
    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'New Lead',  phone: '9101', source: 'direct', assignedAgent: agent1._id, stage: 'new' });
    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Lost Lead', phone: '9102', source: 'direct', assignedAgent: agent1._id, stage: 'lost' });

    const res = await request(app).get('/api/leads?stage=won').set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].stage).toBe('won');
  });

  it('returns empty list for a stage with no leads', async () => {
    const { agent1, mgrToken } = await setupBase();

    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'New Lead', phone: '9103', source: 'direct', assignedAgent: agent1._id, stage: 'new' });

    const res = await request(app).get('/api/leads?stage=negotiation').set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(0);
    expect(res.body.data).toHaveLength(0);
  });
});

/* ─── Filter: by source ───────────────────────────────────────── */

describe('GET /api/leads - filter by source', () => {
  it('filters leads by source correctly', async () => {
    const { agent1, mgrToken } = await setupBase();

    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Direct',   phone: '9110', source: 'direct',   assignedAgent: agent1._id });
    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Referral', phone: '9111', source: 'referral', assignedAgent: agent1._id });
    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Digital',  phone: '9112', source: 'digital',  assignedAgent: agent1._id });

    const res = await request(app).get('/api/leads?source=referral').set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].source).toBe('referral');
  });
});

/* ─── Filter: by assignedAgent ────────────────────────────────── */

describe('GET /api/leads - filter by assignedAgent', () => {
  it('manager can filter by specific agent', async () => {
    const { agent1, agent2, mgrToken } = await setupBase();

    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'A1 Lead', phone: '9120', source: 'direct', assignedAgent: agent1._id });
    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'A2 Lead', phone: '9121', source: 'direct', assignedAgent: agent2._id });

    const res = await request(app)
      .get(`/api/leads?assignedAgent=${agent1._id}`)
      .set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].name).toBe('A1 Lead');
  });
});

/* ─── Filter: by expo ─────────────────────────────────────────── */

describe('GET /api/leads - filter by expo', () => {
  it('returns only leads from specified expo', async () => {
    const { mgrId, agent1, mgrToken } = await setupBase();

    const expo = await Expo.create({
      name: 'Test Expo', startDate: new Date(Date.now() - 86400000 * 5),
      endDate: new Date(Date.now() - 86400000 * 2),
      venue: 'Hall', city: 'Delhi', createdBy: mgrId,
    });

    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Expo Lead',   phone: '9130', source: 'expo', assignedAgent: agent1._id, expo: expo._id });
    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Direct Lead', phone: '9131', source: 'direct', assignedAgent: agent1._id });

    const res = await request(app)
      .get(`/api/leads?expo=${expo._id}`)
      .set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].name).toBe('Expo Lead');
  });
});

/* ─── Filter: overdue leads ───────────────────────────────────── */

describe('GET /api/leads - overdue filter', () => {
  it('returns leads with no followups and no contact', async () => {
    const { mgrId, agent1, mgrToken } = await setupBase();

    await Lead.create({
      name: 'No Contact', phone: '9140', source: 'direct',
      assignedAgent: agent1._id, stage: 'new', lastContact: null, createdBy: mgrId,
    });
    await Lead.create({
      name: 'Won Lead', phone: '9141', source: 'direct',
      assignedAgent: agent1._id, stage: 'won', createdBy: mgrId,
    });

    const res = await request(app).get('/api/leads?overdue=true').set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.every(l => !['won', 'lost'].includes(l.stage))).toBe(true);
  });

  it('does not return recently contacted leads as overdue', async () => {
    const { mgrId, agent1, mgrToken } = await setupBase();

    await Lead.create({
      name: 'Fresh Contact', phone: '9142', source: 'direct',
      assignedAgent: agent1._id, stage: 'interested',
      lastContact: new Date(Date.now() - 86400000), createdBy: mgrId,
    });

    const res = await request(app).get('/api/leads?overdue=true').set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
    const found = res.body.data.find(l => l.name === 'Fresh Contact');
    expect(found).toBeUndefined();
  });
});

/* ─── Pagination ──────────────────────────────────────────────── */

describe('GET /api/leads - pagination', () => {
  it('respects page and limit parameters', async () => {
    const { agent1, mgrToken } = await setupBase();

    for (let i = 1; i <= 10; i++) {
      await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
        .send({ name: `Lead${i}`, phone: `91${String(i).padStart(2, '0')}0`, source: 'direct', assignedAgent: agent1._id });
    }

    const res = await request(app).get('/api/leads?page=2&limit=3').set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(3);
    expect(res.body.pagination.total).toBe(10);
    expect(res.body.pagination.page).toBe(2);
    expect(res.body.pagination.limit).toBe(3);
  });

  it('returns empty array on out-of-range page', async () => {
    const { agent1, mgrToken } = await setupBase();

    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'One Lead', phone: '9200', source: 'direct', assignedAgent: agent1._id });

    const res = await request(app).get('/api/leads?page=99&limit=10').set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(1);
  });

  it('pagination object contains expected fields', async () => {
    const { agent1, mgrToken } = await setupBase();

    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'PagLead', phone: '9210', source: 'direct', assignedAgent: agent1._id });

    const res = await request(app).get('/api/leads?page=1&limit=10').set('Authorization', `Bearer ${mgrToken}`);

    expect(res.body.pagination).toHaveProperty('total');
    expect(res.body.pagination).toHaveProperty('page');
    expect(res.body.pagination).toHaveProperty('limit');
  });
});

/* ─── GET /api/leads/:id ──────────────────────────────────────── */

describe('GET /api/leads/:id', () => {
  it('returns 404 for non-existent lead', async () => {
    const { mgrToken } = await setupBase();

    const res = await request(app)
      .get('/api/leads/000000000000000000000001')
      .set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(404);
  });

  it('returns lead with populated assignedAgent', async () => {
    const { agent1, mgrToken } = await setupBase();

    const create = await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Full Lead', phone: '9220', source: 'direct', assignedAgent: agent1._id });
    const id = create.body.data._id;

    const res = await request(app).get(`/api/leads/${id}`).set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Full Lead');
    expect(res.body.data.assignedAgent).toHaveProperty('name');
  });

  it('agent cannot view lead assigned to another agent', async () => {
    const { agent2, mgrToken, agt1Token } = await setupBase();

    const create = await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Other Lead', phone: '9221', source: 'direct', assignedAgent: agent2._id });
    const id = create.body.data._id;

    const res = await request(app).get(`/api/leads/${id}`).set('Authorization', `Bearer ${agt1Token}`);

    expect(res.status).toBe(403);
  });
});

/* ─── DELETE /api/leads/:id ───────────────────────────────────── */

describe('DELETE /api/leads/:id', () => {
  it('manager can delete a lead', async () => {
    const { agent1, mgrToken } = await setupBase();

    const create = await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Delete Me', phone: '9230', source: 'direct', assignedAgent: agent1._id });
    const id = create.body.data._id;

    const res = await request(app).delete(`/api/leads/${id}`).set('Authorization', `Bearer ${mgrToken}`);
    expect(res.status).toBe(200);

    const get = await request(app).get(`/api/leads/${id}`).set('Authorization', `Bearer ${mgrToken}`);
    expect(get.status).toBe(404);
  });

  it('returns 404 for non-existent lead on delete', async () => {
    const { mgrToken } = await setupBase();

    const res = await request(app)
      .delete('/api/leads/000000000000000000000001')
      .set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(404);
  });
});

/* ─── Lead model virtuals ─────────────────────────────────────── */

describe('Lead model virtuals', () => {
  it('isOverdue is true for new lead with no followups and no contact', async () => {
    const { mgrId, agent1 } = await setupBase();

    const lead = await Lead.create({
      name: 'Overdue Lead', phone: '9240', source: 'direct',
      assignedAgent: agent1._id, stage: 'new', lastContact: null, createdBy: mgrId,
    });

    expect(lead.isOverdue).toBe(true);
  });

  it('isOverdue is false for won lead regardless of contact date', async () => {
    const { mgrId, agent1 } = await setupBase();

    const lead = await Lead.create({
      name: 'Won Overdue', phone: '9241', source: 'direct',
      assignedAgent: agent1._id, stage: 'won', lastContact: null, createdBy: mgrId,
    });

    expect(lead.isOverdue).toBe(false);
  });

  it('isOverdue is false when lastContact is within 7 days', async () => {
    const { mgrId, agent1 } = await setupBase();

    const lead = await Lead.create({
      name: 'Recent Lead', phone: '9242', source: 'direct',
      assignedAgent: agent1._id, stage: 'interested',
      lastContact: new Date(Date.now() - 3 * 86400000), createdBy: mgrId,
    });

    expect(lead.isOverdue).toBe(false);
  });

  it('isOverdue is true when lastContact is older than 7 days', async () => {
    const { mgrId, agent1 } = await setupBase();

    const lead = await Lead.create({
      name: 'Stale Lead', phone: '9243', source: 'direct',
      assignedAgent: agent1._id, stage: 'contacted',
      lastContact: new Date(Date.now() - 10 * 86400000), createdBy: mgrId,
    });

    expect(lead.isOverdue).toBe(true);
  });

  it('followUpCount virtual counts follow-ups correctly', async () => {
    const { mgrId, agent1 } = await setupBase();

    const lead = await Lead.create({
      name: 'FU Count', phone: '9244', source: 'direct',
      assignedAgent: agent1._id, stage: 'new',
      followUps: [
        { agent: agent1._id, channel: 'call',  timestamp: new Date() },
        { agent: agent1._id, channel: 'email', timestamp: new Date() },
      ],
      createdBy: mgrId,
    });

    expect(lead.followUpCount).toBe(2);
  });
});

/* ─── Lead: validation edge cases ────────────────────────────── */

describe('POST /api/leads - validation', () => {
  it('rejects lead with missing required phone', async () => {
    const { agent1, mgrToken } = await setupBase();

    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'No Phone', source: 'direct', assignedAgent: agent1._id });

    expect(res.status).toBe(422);
  });

  it('rejects lead with missing required name', async () => {
    const { agent1, mgrToken } = await setupBase();

    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ phone: '9300', source: 'direct', assignedAgent: agent1._id });

    expect(res.status).toBe(422);
  });

  it('rejects lead with invalid source enum', async () => {
    const { agent1, mgrToken } = await setupBase();

    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Bad Source', phone: '9301', source: 'invalid_source', assignedAgent: agent1._id });

    expect(res.status).toBe(422);
  });

  it('defaults stage to new when not specified', async () => {
    const { agent1, mgrToken } = await setupBase();

    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Default Stage', phone: '9302', source: 'direct', assignedAgent: agent1._id });

    expect(res.status).toBe(201);
    expect(res.body.data.stage).toBe('new');
  });

  it('defaults score to 50 when not specified', async () => {
    const { agent1, mgrToken } = await setupBase();

    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Default Score', phone: '9303', source: 'direct', assignedAgent: agent1._id });

    expect(res.status).toBe(201);
    expect(res.body.data.score).toBe(50);
  });
});

/* ─── Bulk import edge cases ──────────────────────────────────── */

describe('POST /api/leads/bulk - edge cases', () => {
  it('returns 400 when leads array is empty', async () => {
    const { mgrToken } = await setupBase();

    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ leads: [] });

    expect(res.status).toBe(400);
  });

  it('returns 400 when leads field is not an array', async () => {
    const { mgrToken } = await setupBase();

    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ leads: 'not-an-array' });

    expect(res.status).toBe(400);
  });

  it('all leads are duplicates: imported=0', async () => {
    const { agent1, mgrToken } = await setupBase();

    await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Existing', phone: '9310', source: 'direct', assignedAgent: agent1._id });

    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ leads: [{ name: 'Dup', phone: '9310', source: 'direct', assignedAgent: agent1._id }] });

    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(0);
    expect(res.body.data.duplicates).toBe(1);
  });

  it('agent cannot bulk import', async () => {
    const { agent1, agt1Token } = await setupBase();

    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${agt1Token}`)
      .send({ leads: [{ name: 'X', phone: '9320', source: 'direct', assignedAgent: agent1._id }] });

    expect(res.status).toBe(403);
  });
});

/* ─── Follow-up: validation and channels ─────────────────────── */

describe('POST /api/leads/:id/followups - channel validation', () => {
  it('all valid channels are accepted', async () => {
    const { agent1, mgrToken, agt1Token } = await setupBase();

    const create = await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'FU Lead', phone: '9330', source: 'direct', assignedAgent: agent1._id });
    const id = create.body.data._id;

    for (const channel of ['call', 'whatsapp', 'email', 'visit', 'other']) {
      const res = await request(app)
        .post(`/api/leads/${id}/followups`)
        .set('Authorization', `Bearer ${agt1Token}`)
        .send({ channel, note: `Test ${channel}`, outcome: 'Noted' });
      expect(res.status).toBe(201);
    }
  }, 60000);

  it('rejects invalid channel value', async () => {
    const { agent1, mgrToken, agt1Token } = await setupBase();

    const create = await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Bad Channel', phone: '9331', source: 'direct', assignedAgent: agent1._id });
    const id = create.body.data._id;

    const res = await request(app)
      .post(`/api/leads/${id}/followups`)
      .set('Authorization', `Bearer ${agt1Token}`)
      .send({ channel: 'fax', note: 'Test' });

    expect(res.status).toBe(422);
  });

  it('follow-up updates lastContact timestamp', async () => {
    const { agent1, mgrToken, agt1Token } = await setupBase();

    const create = await request(app).post('/api/leads').set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Contact Lead', phone: '9332', source: 'direct', assignedAgent: agent1._id });
    const id = create.body.data._id;

    await request(app)
      .post(`/api/leads/${id}/followups`)
      .set('Authorization', `Bearer ${agt1Token}`)
      .send({ channel: 'call', note: 'Called', outcome: 'Interested' });

    const lead = await Lead.findById(id);
    expect(lead.lastContact).toBeTruthy();
  });
});

/* ─── Health check endpoint ───────────────────────────────────── */

describe('GET /api/health', () => {
  it('returns 200 without authentication', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
});
