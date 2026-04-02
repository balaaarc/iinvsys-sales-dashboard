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

async function insertUser(role) {
  const emailMap = {
    superadmin: 'admin@test.com', manager: 'mgr@test.com',
    agent: 'agt@test.com', readonly: 'ro@test.com',
  };
  const result = await User.collection.insertOne({
    name: role, email: emailMap[role],
    password: '$2b$01$placeholder',
    role, agentId: null, expoId: null, expiresAt: null,
    isTemporary: false, isActive: true,
    lastLogin: null, createdAt: new Date(), updatedAt: new Date(),
  });
  return result.insertedId;
}

function makeToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function tokenFor(role) {
  const id = await insertUser(role);
  return makeToken(id);
}

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString();
}

function pastDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

const sampleExpo = () => ({
  name: 'Tech Expo 2025',
  startDate: futureDate(10),
  endDate: futureDate(15),
  venue: 'Convention Center',
  city: 'Mumbai',
  targetLeads: 200,
});

/* ─── GET /api/expos ──────────────────────────────────────────── */

describe('GET /api/expos', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/expos');
    expect(res.status).toBe(401);
  });

  it('readonly can list expos', async () => {
    const token = await tokenFor('readonly');
    const res   = await request(app).get('/api/expos').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('pagination');
  });

  it('returns paginated results', async () => {
    const token = await tokenFor('manager');

    for (let i = 1; i <= 5; i++) {
      await request(app)
        .post('/api/expos')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...sampleExpo(), name: `Expo${i}`, startDate: futureDate(i), endDate: futureDate(i + 5) });
    }

    const res = await request(app)
      .get('/api/expos?page=1&limit=3')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(3);
    expect(res.body.pagination.total).toBe(5);
  });

  it('filters by status', async () => {
    const token = await tokenFor('manager');

    await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Future Expo', startDate: futureDate(5), endDate: futureDate(10), venue: 'V', city: 'Delhi', targetLeads: 50 });

    const res = await request(app)
      .get('/api/expos?status=upcoming')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    res.body.data.forEach(e => expect(e.status).toBe('upcoming'));
  });

  it('filters by city (case-insensitive)', async () => {
    const token = await tokenFor('manager');

    await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mumbai Expo', startDate: futureDate(1), endDate: futureDate(2), venue: 'V1', city: 'Mumbai', targetLeads: 10 });
    await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Delhi Expo',  startDate: futureDate(3), endDate: futureDate(4), venue: 'V2', city: 'Delhi',  targetLeads: 10 });

    const res = await request(app)
      .get('/api/expos?city=mumbai')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].city).toBe('Mumbai');
  });
});

/* ─── POST /api/expos ─────────────────────────────────────────── */

describe('POST /api/expos', () => {
  it('manager can create an expo', async () => {
    const token = await tokenFor('manager');
    const res   = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Tech Expo 2025');
    expect(res.body.data.city).toBe('Mumbai');
  });

  it('readonly cannot create an expo', async () => {
    const token = await tokenFor('readonly');
    const res   = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    expect(res.status).toBe(403);
  });

  it('agent cannot create an expo', async () => {
    const token = await tokenFor('agent');
    const res   = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    expect(res.status).toBe(403);
  });

  it('rejects expo with missing required fields', async () => {
    const token = await tokenFor('manager');
    const res   = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Incomplete Expo' });
    expect(res.status).toBe(422);
  });

  it('auto-sets status to upcoming for future expo', async () => {
    const token = await tokenFor('manager');
    const res   = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Future', startDate: futureDate(5), endDate: futureDate(10), venue: 'V', city: 'Delhi', targetLeads: 10 });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('upcoming');
  });

  it('auto-sets status to past for expired expo', async () => {
    const token = await tokenFor('manager');
    const res   = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Past Expo', startDate: pastDate(10), endDate: pastDate(5), venue: 'V', city: 'Delhi', targetLeads: 10 });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('past');
  });

  it('auto-sets status to live for currently ongoing expo', async () => {
    const token = await tokenFor('manager');
    const res   = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Live Expo', startDate: pastDate(1), endDate: futureDate(1), venue: 'V', city: 'Delhi', targetLeads: 10 });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('live');
  });
});

/* ─── GET /api/expos/:id ──────────────────────────────────────── */

describe('GET /api/expos/:id', () => {
  it('returns expo with leadCount', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const id     = create.body.data._id;

    const res = await request(app).get(`/api/expos/${id}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('leadCount');
    expect(res.body.data.leadCount).toBe(0);
  });

  it('returns 404 for non-existent expo', async () => {
    const token = await tokenFor('readonly');
    const res   = await request(app)
      .get('/api/expos/000000000000000000000001')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

/* ─── PUT /api/expos/:id ──────────────────────────────────────── */

describe('PUT /api/expos/:id', () => {
  it('manager can update an expo', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const id     = create.body.data._id;

    const res = await request(app).put(`/api/expos/${id}`).set('Authorization', `Bearer ${token}`)
      .send({ ...sampleExpo(), targetLeads: 500 });

    expect(res.status).toBe(200);
    expect(res.body.data.targetLeads).toBe(500);
  });

  it('returns 404 when updating non-existent expo', async () => {
    const token = await tokenFor('manager');
    const res   = await request(app)
      .put('/api/expos/000000000000000000000001')
      .set('Authorization', `Bearer ${token}`)
      .send(sampleExpo());
    expect(res.status).toBe(404);
  });

  it('readonly cannot update an expo', async () => {
    const mgrToken = await tokenFor('manager');
    const create   = await request(app).post('/api/expos').set('Authorization', `Bearer ${mgrToken}`).send(sampleExpo());
    const id       = create.body.data._id;

    const roToken = await tokenFor('readonly');
    const res     = await request(app).put(`/api/expos/${id}`).set('Authorization', `Bearer ${roToken}`)
      .send({ ...sampleExpo(), targetLeads: 1 });
    expect(res.status).toBe(403);
  });
});

/* ─── DELETE /api/expos/:id ───────────────────────────────────── */

describe('DELETE /api/expos/:id', () => {
  it('manager can delete an expo', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const id     = create.body.data._id;

    const res = await request(app).delete(`/api/expos/${id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const get = await request(app).get(`/api/expos/${id}`).set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(404);
  });

  it('readonly cannot delete an expo', async () => {
    const mgrToken = await tokenFor('manager');
    const create   = await request(app).post('/api/expos').set('Authorization', `Bearer ${mgrToken}`).send(sampleExpo());
    const id       = create.body.data._id;

    const roToken = await tokenFor('readonly');
    const res     = await request(app).delete(`/api/expos/${id}`).set('Authorization', `Bearer ${roToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when deleting non-existent expo', async () => {
    const token = await tokenFor('manager');
    const res   = await request(app)
      .delete('/api/expos/000000000000000000000001')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

/* ─── POST /api/expos/:id/referrers ───────────────────────────── */

describe('POST /api/expos/:id/referrers', () => {
  it('manager can create a referrer account', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const expoId = create.body.data._id;

    const res = await request(app)
      .post(`/api/expos/${expoId}/referrers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'John Ref', password: 'RefPass@123' });

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('email');
    expect(res.body.data).toHaveProperty('expiresAt');
    expect(res.body.data.password).toBe('RefPass@123');
  });

  it('referrer email contains expo-based slug', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const expoId = create.body.data._id;

    const res = await request(app)
      .post(`/api/expos/${expoId}/referrers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Ref', password: 'Pass@123' });

    expect(res.status).toBe(201);
    expect(res.body.data.email).toContain('iinvsys');
    expect(res.body.data.email).toContain('jane.ref');
  });

  it('returns 400 when name is missing', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const expoId = create.body.data._id;

    const res = await request(app)
      .post(`/api/expos/${expoId}/referrers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'Pass@123' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const expoId = create.body.data._id;

    const res = await request(app)
      .post(`/api/expos/${expoId}/referrers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Ref' });

    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent expo', async () => {
    const token = await tokenFor('manager');
    const res   = await request(app)
      .post('/api/expos/000000000000000000000001/referrers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', password: 'Pass@123' });
    expect(res.status).toBe(404);
  });
});

/* ─── GET /api/expos/:id/referrers ───────────────────────────── */

describe('GET /api/expos/:id/referrers', () => {
  it('returns list of referrers for expo (no password exposed)', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const expoId = create.body.data._id;

    await request(app).post(`/api/expos/${expoId}/referrers`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ref One', password: 'Pass@123' });
    await request(app).post(`/api/expos/${expoId}/referrers`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ref Two', password: 'Pass@123' });

    const res = await request(app).get(`/api/expos/${expoId}/referrers`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    res.body.data.forEach(r => expect(r).not.toHaveProperty('password'));
  });

  it('referrers include leadCount', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const expoId = create.body.data._id;

    await request(app).post(`/api/expos/${expoId}/referrers`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ref One', password: 'Pass@123' });

    const res = await request(app).get(`/api/expos/${expoId}/referrers`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toHaveProperty('leadCount');
    expect(res.body.data[0].leadCount).toBe(0);
  });
});

/* ─── DELETE /api/expos/:id/referrers/:uid ────────────────────── */

describe('DELETE /api/expos/:id/referrers/:uid', () => {
  it('manager can delete a referrer', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const expoId = create.body.data._id;

    const refRes = await request(app).post(`/api/expos/${expoId}/referrers`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ref Delete', password: 'Pass@123' });
    const refId = refRes.body.data.id;

    const res = await request(app)
      .delete(`/api/expos/${expoId}/referrers/${refId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);

    const listRes = await request(app).get(`/api/expos/${expoId}/referrers`).set('Authorization', `Bearer ${token}`);
    expect(listRes.body.data.length).toBe(0);
  });

  it('returns 404 for non-existent referrer', async () => {
    const token  = await tokenFor('manager');
    const create = await request(app).post('/api/expos').set('Authorization', `Bearer ${token}`).send(sampleExpo());
    const expoId = create.body.data._id;

    const res = await request(app)
      .delete(`/api/expos/${expoId}/referrers/000000000000000000000001`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
