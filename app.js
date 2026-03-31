'use strict';
/* ══════════════════════════════════════════════════════
   IINVSYS Sales OS — app.js v2.0
   Real API integration · Node.js + MongoDB backend
══════════════════════════════════════════════════════ */

/* ═══════════ API LAYER ═══════════ */
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:5001/api'
  : '/api';
let _token = localStorage.getItem('ii_token') || null;

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (_token) opts.headers['Authorization'] = `Bearer ${_token}`;
  if (body)   opts.body = JSON.stringify(body);
  const res  = await fetch(API_BASE + path, opts);
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || 'API error'), { status: res.status, data });
  return data;
}

/* ═══════════ NORMALIZERS ═══════════ */
function normalizeLead(l) {
  return {
    id:          l._id,
    name:        l.name,
    phone:       l.phone,
    email:       l.email || '',
    source:      l.source,
    expo:        l.expo ? (l.expo.name || '') : '',
    expoId:      l.expo ? (l.expo._id || l.expo) : null,
    stage:       l.stage,
    agentId:     l.assignedAgent?._id || (typeof l.assignedAgent === 'string' ? l.assignedAgent : null),
    products:    (l.products || []).map(p => p._id || p),
    value:       l.value || 0,
    score:       l.score || 50,
    followUps:   Array.isArray(l.followUps) ? l.followUps.length : (l.followUps || 0),
    notes:       l.notes || '',
    createdAt:   l.createdAt ? l.createdAt.split('T')[0] : null,
    lastContact: l.lastContact ? l.lastContact.split('T')[0] : null,
  };
}

function normalizeAgent(a) {
  return {
    id:          a._id,
    name:        a.name,
    initials:    a.initials,
    email:       a.email,
    phone:       a.phone,
    territory:   a.territory,
    designation: a.designation || 'Sales Agent',
    status:      a.status,
    target:      a.target || 0,
    color:       a.color || 'var(--gold)',
    joinDate:    a.joinDate,
  };
}

function normalizeProduct(p) {
  return {
    id:       p._id,
    name:     p.name,
    sku:      p.sku,
    category: p.category,
    price:    p.price,
    desc:     p.description || '',
  };
}

function normalizeExpo(e, leadsArr) {
  const id    = e._id;
  const count = leadsArr ? leadsArr.filter(l => l.expoId === id).length : (e.leadCount || 0);
  const start = new Date(e.startDate);
  const end   = new Date(e.endDate);
  const fmt   = d => d.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
  return {
    id,
    name:      e.name,
    dates:     `${fmt(start)} – ${fmt(end)}`,
    venue:     [e.venue, e.city].filter(Boolean).join(', '),
    agents:    (e.agents || []).map(a => a._id || a),
    status:    e.status,
    leadCount: count,
    converted: e.converted || 0,
  };
}

/* ═══════════ STATE ═══════════ */
const S = {
  session:   null,
  leads:     [],
  products:  [],
  agents:    [],
  expos:     [],
  csvParsed: [],
};

/* ═══════════ HELPERS ═══════════ */
function uid() { return 'x' + Math.random().toString(36).slice(2,9); }
function isAdmin()      { return S.session?.role === 'superadmin' || S.session?.role === 'manager'; }
function isAgent()      { return S.session?.role === 'agent'; }
function isSuperAdmin() { return S.session?.role === 'superadmin'; }
function isReferrer()   { return S.session?.role === 'referrer'; }
function agentById(id)   { return S.agents.find(a => a.id === id); }
function productById(id) { return S.products.find(p => p.id === id); }
function fmtValue(v) {
  if (!v || v === 0) return '—';
  if (v >= 100000) return '₹' + (v/100000).toFixed(1) + 'L';
  return '₹' + (v/1000).toFixed(0) + 'K';
}
function stageColor(stage) {
  const m = { new:'var(--gold)', contacted:'var(--amber)', interested:'var(--azure)', proposal:'var(--violet)', negotiation:'var(--amber)', won:'var(--emerald)', lost:'var(--coral)' };
  return m[stage] || 'var(--text-3)';
}
function scoreBadgeClass(score) {
  if (score >= 75) return 'hot';
  if (score >= 45) return 'warm';
  return 'cold';
}
function daysSince(dateStr) {
  if (!dateStr) return 999;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

/* ═══════════ LOADER HELPERS ═══════════ */
function showLoader(msg = 'Loading…') {
  const el  = document.getElementById('globalLoader');
  const txt = document.getElementById('loaderMsg');
  if (txt) txt.textContent = msg.toUpperCase();
  el?.classList.remove('hidden');
}
function hideLoader() {
  document.getElementById('globalLoader')?.classList.add('hidden');
}
function showRefresh() {
  document.getElementById('refreshBar')?.classList.remove('hidden');
}
function hideRefresh() {
  document.getElementById('refreshBar')?.classList.add('hidden');
}
/** Set a button into loading/idle state. */
function btnLoad(btn, loading, loadLabel) {
  if (!btn) return;
  btn.disabled = loading;
  btn.dataset.loading = loading ? 'true' : 'false';
  if (loading) {
    btn.dataset.origText = btn.textContent;
    if (loadLabel) btn.textContent = loadLabel;
  } else if (btn.dataset.origText !== undefined) {
    btn.textContent = btn.dataset.origText;
    delete btn.dataset.origText;
  }
}
/** Returns HTML for an inline content spinner. */
function contentSpinner(msg = 'Loading…') {
  return `<div class="content-spinner">
    <div class="content-spinner-ring"></div>
    <div class="content-spinner-text">${msg.toUpperCase()}</div>
  </div>`;
}

/* ═══════════ AUTH ═══════════ */
document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email   = document.getElementById('loginEmail').value.trim().toLowerCase();
  const pass    = document.getElementById('loginPassword').value;
  const errEl   = document.getElementById('loginError');
  const signBtn = e.target.querySelector('[type=submit]');
  btnLoad(signBtn, true, 'Signing in…');
  showLoader('Signing in…');
  try {
    const res = await api('POST', '/auth/login', { email, password: pass });
    _token = res.data.token;
    localStorage.setItem('ii_token', _token);
    S.session = { ...res.data.user, id: res.data.user.id };
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    await initApp();
  } catch (err) {
    hideLoader();
    btnLoad(signBtn, false);
    errEl.classList.remove('hidden');
    setTimeout(() => errEl.classList.add('hidden'), 3000);
  }
});

// Demo credential fill buttons
document.querySelectorAll('.demo-cred-row').forEach(row => {
  row.querySelector('.demo-fill-btn').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('loginEmail').value    = row.dataset.email;
    document.getElementById('loginPassword').value = row.dataset.pass;
  });
  row.addEventListener('click', () => {
    document.getElementById('loginEmail').value    = row.dataset.email;
    document.getElementById('loginPassword').value = row.dataset.pass;
  });
});

document.getElementById('pwdToggle').addEventListener('click', () => {
  const inp = document.getElementById('loginPassword');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  S.session  = null;
  _token     = null;
  S.leads    = []; S.products = []; S.agents = []; S.expos = [];
  localStorage.removeItem('ii_token');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginPage').classList.remove('hidden');
  document.getElementById('loginPassword').value = '';
  analyticsInit = false;
});

/* ═══════════ DATA LOADING ═══════════ */
async function loadAllData(refresh = false) {
  if (refresh) showRefresh();
  try {
    const [agentsRes, productsRes, leadsRes, exposRes] = await Promise.all([
      api('GET', '/agents'),
      api('GET', '/products'),
      api('GET', '/leads'),
      api('GET', '/expos'),
    ]);
    S.agents   = agentsRes.data.map(normalizeAgent);
    S.products = productsRes.data.map(normalizeProduct);
    S.leads    = leadsRes.data.map(normalizeLead);
    S.expos    = exposRes.data.map(e => normalizeExpo(e, S.leads));
  } finally {
    if (refresh) hideRefresh();
  }
}

async function loadReferrerData() {
  /* Referrers can only read expos — they cannot list leads/agents */
  try {
    const exposRes = await api('GET', '/expos');
    S.expos = exposRes.data.map(e => normalizeExpo(e));
  } catch(e) { /* non-fatal */ }
}

/* ═══════════ APP INIT ═══════════ */
async function initApp() {
  showLoader('Loading data…');
  try {
    if (isReferrer()) {
      await loadReferrerData();
    } else {
      await loadAllData();
    }
  } catch (err) {
    hideLoader();
    flash('Failed to load data. Check server connection.', 'error');
    return;
  }
  applyRole();
  updateSidebarUser();
  updateDate();
  if (isReferrer()) {
    renderReferrerView();
    goToPage('referrer');
  } else if (isAdmin()) {
    populateAgentDropdowns();
    renderOverview();
    goToPage('overview');
  } else {
    populateAgentDropdowns();
    renderMyLeads();
    goToPage('myLeads');
  }
  updateNavCounts();
  hideLoader();
}

function applyRole() {
  const ref = isReferrer();
  const agt = isAgent();
  const adminOnly = document.querySelectorAll('.admin-only, .admin-only-page, .admin-only-field');
  adminOnly.forEach(el => el.classList.toggle('hidden', agt || ref));
  document.getElementById('adminNav').classList.toggle('hidden', agt || ref);
  document.getElementById('agentNav').classList.toggle('hidden', isAdmin() || ref);
  document.getElementById('addLeadBtn').classList.toggle('hidden', ref);
  // Show camera scan button on mobile or any device with camera access
  if ('mediaDevices' in navigator) {
    document.getElementById('cameraScanBtn')?.classList.remove('hidden');
  }
}

function updateSidebarUser() {
  const u = S.session;
  const roleMap = { superadmin:'Super Admin', manager:'Manager', agent:'Sales Agent', referrer:'Referrer', readonly:'Viewer' };
  const roleColors = { superadmin:'var(--gold)', manager:'var(--amber)', agent:'var(--emerald)', referrer:'var(--violet)', readonly:'var(--text-3)' };
  document.getElementById('sidebarAvatar').textContent = u.initials || u.name?.charAt(0) || '?';
  document.getElementById('sidebarName').textContent   = u.name;
  document.getElementById('sidebarRole').textContent   = roleMap[u.role] || u.role;
  document.getElementById('roleLabel').textContent     = roleMap[u.role] || u.role;
  const dot = document.getElementById('roleDot');
  dot.style.background = roleColors[u.role] || 'var(--text-3)';
}

function updateDate() {
  const el = document.getElementById('liveDate');
  if (el) el.textContent = new Date().toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
}

function updateNavCounts() {
  const myLeads = isAgent() ? S.leads.filter(l => l.agentId === S.session.agentId) : S.leads;
  const navLead = document.getElementById('navLeadCount');
  if (navLead) navLead.textContent = S.leads.length;
  const navMy = document.getElementById('navMyLeadCount');
  if (navMy) navMy.textContent = myLeads.length;
  const navProd = document.getElementById('navProductCount');
  if (navProd) navProd.textContent = S.products.length;
}

function populateAgentDropdowns() {
  const sel = document.getElementById('filterAgent');
  if (sel) {
    sel.innerHTML = '<option value="">All Agents</option>';
    S.agents.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id; opt.textContent = a.name;
      sel.appendChild(opt);
    });
  }
  const leadAgentSel = document.getElementById('leadAgent');
  if (leadAgentSel) {
    leadAgentSel.innerHTML = '<option value="">— Auto-assign —</option>';
    S.agents.filter(a => a.status === 'active').forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id; opt.textContent = a.name;
      leadAgentSel.appendChild(opt);
    });
  }
}

/* ═══════════ PAGE NAVIGATION ═══════════ */
const PAGE_META = {
  overview:  { eyebrow:'// COMMAND CENTRE',  title:'Sales <em>Overview</em>' },
  leads:     { eyebrow:'// PIPELINE',        title:'Lead <em>Management</em>' },
  agents:    { eyebrow:'// TEAM',            title:'Agent <em>Directory</em>' },
  products:  { eyebrow:'// CATALOGUE',       title:'Product <em>Catalogue</em>' },
  expos:     { eyebrow:'// EVENTS',          title:'Expo <em>Management</em>' },
  analytics: { eyebrow:'// INSIGHTS',        title:'Sales <em>Analytics</em>' },
  myLeads:   { eyebrow:'// MY PIPELINE',     title:'My <em>Leads</em>' },
  myStats:   { eyebrow:'// MY PERFORMANCE',  title:'My <em>Stats</em>' },
  settings:  { eyebrow:'// CONFIGURATION',   title:'System <em>Settings</em>' },
  referrer:  { eyebrow:'// LEAD CAPTURE',    title:'Add <em>Lead</em>' },
};

function goToPage(pageId) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === pageId));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${pageId}`));
  const m = PAGE_META[pageId] || PAGE_META.overview;
  document.getElementById('pageEyebrow').textContent = m.eyebrow;
  document.getElementById('pageTitle').innerHTML = m.title;
  closeMobileNav();
  // Lazy renders
  if (pageId === 'leads')     renderKanban(getFilters());
  if (pageId === 'agents')    renderAgentsGrid();
  if (pageId === 'products')  renderProductsTable();
  if (pageId === 'expos')     renderExpos();
  if (pageId === 'analytics') initAnalyticsCharts();
  if (pageId === 'myLeads')   renderMyLeads();
  if (pageId === 'myStats')   renderMyStats();
  if (pageId === 'settings')  renderSettings();
  if (pageId === 'referrer')  renderReferrerView();
}

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('click', e => { e.preventDefault(); goToPage(item.dataset.page); });
});
document.querySelectorAll('[data-page]:not(.nav-item)').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); goToPage(el.dataset.page); });
});

/* ── Mobile nav ── */
const sidebarEl  = document.getElementById('sidebar');
document.getElementById('mobileToggle')?.addEventListener('click', () => sidebarEl.classList.toggle('open'));
function closeMobileNav() { sidebarEl?.classList.remove('open'); }

/* ═══════════ OVERVIEW RENDERING ═══════════ */
function renderOverview() {
  renderKPIs();
  renderFunnel('all');
  renderLeaderboard('month');
  renderSourceChart();
  renderTrendChart();
  renderActivityStream();
  renderExpoMini();
}

/* ── KPIs ── */
function renderKPIs() {
  const total   = S.leads.length;
  const won     = S.leads.filter(l => l.stage === 'won').length;
  const convPct = total ? Math.round((won/total)*100) : 0;
  const pipeline = S.leads.filter(l => !['won','lost'].includes(l.stage)).reduce((s,l) => s + (l.value||0), 0);
  const withFU   = S.leads.filter(l => l.followUps > 0).length;
  const fuPct    = total ? Math.round((withFU/total)*100) : 0;
  const wonLeads = S.leads.filter(l => l.stage === 'won');
  const avgDeal  = wonLeads.length ? wonLeads.reduce((s,l)=>s+(l.value||0),0)/wonLeads.length : 0;
  const overdue  = S.leads.filter(l => !['won','lost'].includes(l.stage) && daysSince(l.lastContact) > 7).length;

  animateCounter('kpiTotalLeads', total,   '',   '');
  animateCounter('kpiConvRate',   convPct, '',   '%');
  animateCounter('kpiFollowup',   fuPct,   '',   '%');
  animateCounter('kpiOverdue',    overdue, '',   '');
  const pip = document.getElementById('kpiPipeline');
  const avg = document.getElementById('kpiAvgDeal');
  if (pip) { setTimeout(() => { pip.textContent = fmtValue(pipeline); }, 200); }
  if (avg) { setTimeout(() => { avg.textContent = fmtValue(avgDeal);  }, 300); }
}

function animateCounter(elId, target, prefix, suffix) {
  const el = document.getElementById(elId);
  if (!el) return;
  const dur  = 1200;
  const isFloat = !Number.isInteger(target);
  const start = performance.now();
  function tick(now) {
    const p = Math.min((now - start)/dur, 1);
    const e = 1 - Math.pow(1-p, 3);
    const v = target * e;
    el.textContent = prefix + (isFloat ? v.toFixed(1) : Math.floor(v)) + suffix;
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = prefix + target + suffix;
  }
  requestAnimationFrame(tick);
}

/* ── FUNNEL ── */
const STAGES = ['new','contacted','interested','proposal','negotiation','won','lost'];
const STAGE_LABELS = { new:'NEW', contacted:'CONTACTED', interested:'INTERESTED', proposal:'PROPOSAL', negotiation:'NEGOTIATION', won:'CLOSED WON', lost:'CLOSED LOST' };
const STAGE_COLORS = { new:'var(--gold)', contacted:'var(--amber)', interested:'var(--azure)', proposal:'var(--violet)', negotiation:'var(--amber)', won:'var(--emerald)', lost:'var(--coral)' };

function renderFunnel(filter) {
  const body = document.getElementById('funnelBody');
  if (!body) return;
  let leads = S.leads;
  if (filter === 'expo')   leads = leads.filter(l => l.source === 'expo');
  if (filter === 'direct') leads = leads.filter(l => l.source === 'direct');
  const total = leads.length || 1;
  body.innerHTML = STAGES.map(stage => {
    const count = leads.filter(l => l.stage === stage).length;
    const pct   = Math.round((count/total)*100);
    const w     = Math.max(pct, 4);
    return `<div class="funnel-stage" style="--w:${w}%;--color:${STAGE_COLORS[stage]}">
      <div class="funnel-bar"><div class="funnel-fill"></div></div>
      <div class="funnel-info">
        <span class="funnel-label">${STAGE_LABELS[stage]}</span>
        <span class="funnel-num">${count}</span>
        <span class="funnel-pct">${pct}%</span>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('funnelTabs')?.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('#funnelTabs .tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderFunnel(btn.dataset.filter);
});

/* ── LEADERBOARD ── */
function renderLeaderboard(period) {
  const list = document.getElementById('leaderboardList');
  if (!list) return;
  const ranked = S.agents.filter(a => a.status === 'active').map(a => {
    const aLeads = S.leads.filter(l => l.agentId === a.id);
    const won    = aLeads.filter(l => l.stage === 'won');
    const pipeline = aLeads.reduce((s,l) => s+(l.value||0),0);
    return { ...a, totalLeads:aLeads.length, won:won.length, pipeline };
  }).sort((a,b) => b.won - a.won || b.pipeline - a.pipeline);

  list.innerHTML = ranked.map((a, i) => {
    const rank = i+1;
    const rankClass = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : '';
    const pct  = ranked[0].pipeline ? Math.round((a.pipeline/ranked[0].pipeline)*100) : 0;
    return `<div class="lb-item ${rankClass}">
      <div class="lb-rank">0${rank}</div>
      <div class="lb-avatar" style="--ac:${a.color}">${a.initials}</div>
      <div class="lb-info">
        <span class="lb-name">${a.name}</span>
        <span class="lb-territory">${a.territory}</span>
      </div>
      <div class="lb-stats">
        <div class="lb-stat"><span class="lb-stat-val green-text">${a.won}</span><span class="lb-stat-label">Won</span></div>
        <div class="lb-stat"><span class="lb-stat-val">${a.totalLeads}</span><span class="lb-stat-label">Leads</span></div>
        <div class="lb-stat"><span class="lb-stat-val">${fmtValue(a.pipeline)}</span><span class="lb-stat-label">Value</span></div>
      </div>
      <div class="lb-bar-wrap"><div class="lb-bar" style="--pct:${pct}%"></div></div>
    </div>`;
  }).join('');
}

document.getElementById('lbTabs')?.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('#lbTabs .tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderLeaderboard(btn.dataset.period);
});

/* ── SOURCE CHART ── */
let sourceChartInst = null;
function renderSourceChart() {
  const ctx = document.getElementById('sourceChart');
  if (!ctx) return;
  const sources = { expo:0, referral:0, direct:0, digital:0 };
  S.leads.forEach(l => { if (sources[l.source] !== undefined) sources[l.source]++; });
  const total = S.leads.length || 1;
  const data  = Object.values(sources);
  const labels = Object.keys(sources).map(s => s.charAt(0).toUpperCase()+s.slice(1));
  if (sourceChartInst) { sourceChartInst.destroy(); }
  sourceChartInst = new Chart(ctx, {
    type:'doughnut',
    data:{ labels, datasets:[{ data, backgroundColor:['#F0BE18','#2979FF','#00DFA2','#FF8C00'], borderColor:'#0f0f0f', borderWidth:3, hoverOffset:8 }] },
    options:{ cutout:'68%', plugins:{ legend:{ display:false }, tooltip:{ backgroundColor:'#161616', borderColor:'#333', borderWidth:1, callbacks:{ label: c => ` ${c.label}: ${c.raw} (${Math.round(c.raw/total*100)}%)` } } }, animation:{ animateScale:true, duration:1200 } }
  });
  const leg = document.getElementById('sourceLegend');
  if (leg) {
    const cols = ['var(--gold)','var(--azure)','var(--emerald)','var(--amber)'];
    leg.innerHTML = labels.map((l,i) => `<div class="source-leg-item"><span class="leg-dot" style="background:${cols[i]}"></span>${l} <strong>${Math.round(data[i]/total*100)}%</strong></div>`).join('');
  }
}

/* ── TREND CHART ── */
let trendChartInst = null;
function renderTrendChart() {
  const ctx = document.getElementById('trendChart');
  if (!ctx) return;
  if (trendChartInst) trendChartInst.destroy();
  const months = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
  const leads  = [84,92,78,110,124,98,140,132,158,146,172,S.leads.length];
  const won    = [14,18,12,24,28,22,34,30,38,32,41,S.leads.filter(l=>l.stage==='won').length];
  trendChartInst = new Chart(ctx, {
    type:'line',
    data:{ labels:months, datasets:[
      { label:'Total Leads', data:leads, borderColor:'#2979FF', backgroundColor:'rgba(41,121,255,0.06)', fill:true, tension:0.4, borderWidth:2, pointBackgroundColor:'#2979FF', pointRadius:3 },
      { label:'Conversions', data:won,   borderColor:'#00DFA2', backgroundColor:'rgba(0,223,162,0.06)',  fill:true, tension:0.4, borderWidth:2, pointBackgroundColor:'#00DFA2', pointRadius:3 }
    ]},
    options:{ responsive:true, interaction:{mode:'index',intersect:false}, plugins:{ legend:{display:true,labels:{color:'#666',boxWidth:10,font:{size:10}}}, tooltip:{backgroundColor:'#161616',borderColor:'#333',borderWidth:1} }, scales:{ x:{grid:{color:'#1a1a1a'},ticks:{color:'#444',font:{size:10}}}, y:{grid:{color:'#1a1a1a'},ticks:{color:'#444',font:{size:10}}} }, animation:{duration:1400} }
  });
}

/* ── ACTIVITY STREAM ── */
const ACTIVITIES_SEED = [
  { dot:'emerald', msg:'<strong>New lead</strong> created from API',                     meta:'Live data from MongoDB · <span class="act-time">Just now</span>',         tag:'new',      tagLabel:'NEW' },
  { dot:'gold',    msg:'<strong>Database</strong> connected successfully',                meta:'MongoDB · localhost:27017 · <span class="act-time">On startup</span>',  tag:'won',      tagLabel:'LIVE' },
  { dot:'azure',   msg:'<strong>API server</strong> running on port 5001',               meta:'Node.js + Express · <span class="act-time">Active</span>',              tag:'follow',   tagLabel:'API' },
  { dot:'amber',   msg:'<strong>Seed data</strong> loaded — 15 leads, 6 agents',        meta:'Run node src/utils/seed.js · <span class="act-time">Seeded</span>',     tag:'proposal', tagLabel:'SEED' },
  { dot:'violet',  msg:'<strong>JWT auth</strong> protecting all routes',                meta:'Role-based: superadmin, manager, agent · <span class="act-time">Secured</span>', tag:'won', tagLabel:'AUTH' },
  { dot:'coral',   msg:'<strong>Bulk CSV import</strong> available via API',             meta:'POST /api/leads/bulk-import · dedup by phone · <span class="act-time">Ready</span>', tag:'overdue', tagLabel:'IMPORT' },
];

function renderActivityStream() {
  const list = document.getElementById('activityList');
  if (!list) return;
  list.innerHTML = ACTIVITIES_SEED.map(a => `
    <div class="act-item">
      <div class="act-dot ${a.dot}"></div>
      <div class="act-body">
        <span class="act-msg">${a.msg}</span>
        <span class="act-meta">${a.meta}</span>
      </div>
      <span class="act-tag ${a.tag}">${a.tagLabel}</span>
    </div>`).join('');
}

/* ── EXPO MINI ── */
function renderExpoMini() {
  const list = document.getElementById('expoMiniList');
  if (!list) return;
  list.innerHTML = S.expos.map(e => {
    const dot   = e.status === 'live' ? 'live' : e.status === 'upcoming' ? 'upcoming' : 'past';
    const badge = e.status === 'live' ? '<span class="expo-status live-badge-sm">LIVE</span>' : e.status === 'upcoming' ? '<span class="expo-status upcoming-badge">UPCOMING</span>' : '<span class="expo-status past-badge">DONE</span>';
    return `<div class="expo-mini">
      <div class="expo-mini-dot ${dot}"></div>
      <div class="expo-mini-info">
        <span class="expo-mini-name">${e.name}</span>
        <span class="expo-mini-sub">${e.dates} · ${e.agents.length} agents</span>
      </div>
      <div class="expo-mini-stats">
        <span class="expo-mini-count">${e.leadCount || '—'} <small>leads</small></span>
        ${badge}
      </div>
    </div>`;
  }).join('');
}

/* ═══════════ LEAD KANBAN ═══════════ */
function getFilters() {
  return {
    search:  (document.getElementById('leadSearch')?.value || '').toLowerCase(),
    stage:   document.getElementById('filterStage')?.value  || '',
    source:  document.getElementById('filterSource')?.value || '',
    agentId: document.getElementById('filterAgent')?.value  || '',
  };
}

function filteredLeads(leads, f) {
  return leads.filter(l => {
    if (f.search  && !l.name.toLowerCase().includes(f.search) && !l.phone.includes(f.search) && !(l.source||'').includes(f.search)) return false;
    if (f.stage   && l.stage   !== f.stage)   return false;
    if (f.source  && l.source  !== f.source)  return false;
    if (f.agentId && l.agentId !== f.agentId) return false;
    return true;
  });
}

function renderKanban(filters = {}, boardId = 'kanbanBoard', leadsPool = null) {
  const board = document.getElementById(boardId);
  if (!board) return;
  const pool = leadsPool || S.leads;
  const fl   = filteredLeads(pool, filters);
  const activeStages = filters.stage ? [filters.stage] : STAGES;

  board.innerHTML = activeStages.map(stage => {
    const stageLeads = fl.filter(l => l.stage === stage);
    const stageColor = STAGE_COLORS[stage];
    return `
    <div class="kanban-col" data-stage="${stage}">
      <div class="kanban-col-header">
        <span class="kanban-stage-dot" style="background:${stageColor}"></span>
        <span class="kanban-stage-name">${STAGE_LABELS[stage]}</span>
        <span class="kanban-stage-count">${stageLeads.length}</span>
      </div>
      <div class="kanban-cards">
        ${stageLeads.length === 0 ? `<div class="kanban-empty"><span>No leads</span></div>` : stageLeads.map(l => leadCardHTML(l)).join('')}
      </div>
    </div>`;
  }).join('');

  board.querySelectorAll('.lead-card').forEach(card => {
    card.addEventListener('click', () => openLeadModal(card.dataset.id));
  });
}

function leadCardHTML(l) {
  const agent   = agentById(l.agentId);
  const overdue = !['won','lost'].includes(l.stage) && daysSince(l.lastContact) > 7;
  const bClass  = overdue ? 'overdue-flag' : '';
  const borderMap = { new:'gold-border', contacted:'amber-border', interested:'blue-border', proposal:'blue-border', negotiation:'amber-border', won:'green-border', lost:'red-border' };
  const prodTags  = (l.products||[]).slice(0,2).map(pid => {
    const p = productById(pid);
    return p ? `<span class="ltag amber">${p.name}</span>` : '';
  }).join('');

  return `<div class="lead-card ${borderMap[l.stage]||''} ${bClass}" data-id="${l.id}">
    <div class="lead-card-top">
      <span class="lead-name">${l.name}</span>
      <span class="lead-score ${l.stage==='won'?'won-score':scoreBadgeClass(l.score)}">${l.stage==='won'?'✓':l.score}</span>
    </div>
    <div class="lead-detail">📞 ${l.phone}</div>
    <div class="lead-detail">◇ ${l.source.charAt(0).toUpperCase()+l.source.slice(1)}${l.expo ? ' — ' + l.expo : ''}</div>
    ${prodTags ? `<div class="lead-tags">${prodTags}</div>` : ''}
    <div class="lead-footer">
      <div class="lead-agent" style="background:${agent?.color||'var(--text-3)'}">${agent?.initials||'?'}</div>
      <span class="lead-time ${overdue?'overdue-text':''}">${overdue ? '⚠ Overdue' : l.lastContact ? relTime(l.lastContact) : 'Just added'}</span>
      <span class="lead-fu">${l.followUps > 0 ? '↩ '+l.followUps+' FU' : 'No FU yet'}</span>
    </div>
  </div>`;
}

function relTime(dateStr) {
  const d = daysSince(dateStr);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  return d + ' days ago';
}

// Kanban empty style
const kanbanEmptyStyle = document.createElement('style');
kanbanEmptyStyle.textContent = `.kanban-empty { padding:20px; text-align:center; font-family:var(--font-mono); font-size:10px; color:var(--text-4); letter-spacing:1px; }`;
document.head.appendChild(kanbanEmptyStyle);

/* ── FILTER EVENTS ── */
['leadSearch','filterStage','filterSource','filterAgent'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => renderKanban(getFilters()));
});
['myLeadSearch','myFilterStage'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => {
    const myLeads = S.leads.filter(l => l.agentId === S.session?.agentId);
    const f = {
      search: (document.getElementById('myLeadSearch')?.value||'').toLowerCase(),
      stage:  document.getElementById('myFilterStage')?.value||'',
    };
    renderKanban(f, 'myKanbanBoard', myLeads);
  });
});

/* ═══════════ LEAD CRUD MODAL ═══════════ */
function openLeadModal(leadId) {
  const modal = document.getElementById('leadModal');
  const form  = document.getElementById('leadForm');
  const isNew = !leadId;

  document.getElementById('leadModalEyebrow').textContent = isNew ? '// QUICK CAPTURE' : '// EDIT LEAD';
  document.getElementById('leadModalTitle').innerHTML     = isNew ? 'New <em>Lead</em>' : 'Edit <em>Lead</em>';
  document.getElementById('leadSubmitBtn').textContent    = isNew ? 'Capture Lead →' : 'Save Changes →';
  const delBtn = document.getElementById('deleteLeadBtn');
  delBtn.classList.toggle('hidden', isNew || !isAdmin());

  // Populate product checkboxes
  const tagWrap = document.getElementById('leadProductTags');
  tagWrap.innerHTML = S.products.map(p =>
    `<label class="ptag-check" data-pid="${p.id}"><input type="checkbox" value="${p.id}"/><span>${p.name}</span></label>`
  ).join('');

  if (isNew) {
    form.reset();
    document.getElementById('leadIdInput').value = '';
    if (isAgent()) document.getElementById('leadAgent').value = S.session.agentId;
  } else {
    const l = S.leads.find(x => x.id === leadId);
    if (!l) return;
    document.getElementById('leadIdInput').value  = l.id;
    document.getElementById('leadName').value     = l.name;
    document.getElementById('leadPhone').value    = l.phone;
    document.getElementById('leadEmail').value    = l.email;
    document.getElementById('leadStage').value    = l.stage;
    document.getElementById('leadSource').value   = l.source;
    document.getElementById('leadExpo').value     = l.expo;
    document.getElementById('leadAgent').value    = l.agentId || '';
    document.getElementById('leadValue').value    = l.value   || '';
    document.getElementById('leadNotes').value    = l.notes   || '';
    tagWrap.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.checked = (l.products||[]).includes(cb.value);
    });
    if (isAgent()) {
      ['leadName','leadPhone','leadEmail','leadSource','leadExpo','leadValue','leadNotes'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.setAttribute('readonly',''); el.style.opacity='0.5'; }
      });
      tagWrap.querySelectorAll('input').forEach(cb => { cb.disabled = true; });
    }
  }

  if (!isAgent() || isNew) {
    ['leadName','leadPhone','leadEmail','leadSource','leadExpo','leadValue','leadNotes'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.removeAttribute('readonly'); el.style.opacity=''; }
    });
    tagWrap.querySelectorAll('input').forEach(cb => { cb.disabled = false; });
  }

  delBtn.onclick = () => confirmDelete('lead', leadId, () => {
    modal.classList.remove('open');
  });

  modal.classList.add('open');
}

document.getElementById('leadModalClose').addEventListener('click',  () => document.getElementById('leadModal').classList.remove('open'));
document.getElementById('leadModalCancel').addEventListener('click', () => document.getElementById('leadModal').classList.remove('open'));
document.getElementById('leadModal').addEventListener('click', e => { if (e.target === document.getElementById('leadModal')) document.getElementById('leadModal').classList.remove('open'); });

document.getElementById('leadForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id    = document.getElementById('leadIdInput').value;
  const name  = document.getElementById('leadName').value.trim();
  const phone = document.getElementById('leadPhone').value.trim();
  if (!name || !phone) { flash('Name and Phone are required', 'error'); return; }

  const products = Array.from(document.querySelectorAll('#leadProductTags input:checked')).map(c => c.value);
  const payload  = {
    name, phone,
    email:         document.getElementById('leadEmail').value.trim(),
    stage:         document.getElementById('leadStage').value,
    source:        document.getElementById('leadSource').value  || 'direct',
    assignedAgent: document.getElementById('leadAgent').value   || S.agents.find(a=>a.status==='active')?.id,
    value:         parseInt(document.getElementById('leadValue').value) || 0,
    notes:         document.getElementById('leadNotes').value.trim(),
    products,
  };

  const btn = document.getElementById('leadSubmitBtn');
  btnLoad(btn, true, id ? 'Saving…' : 'Capturing…');
  try {
    if (id) {
      await api('PUT', `/leads/${id}`, payload);
      flash('Lead updated successfully');
    } else {
      await api('POST', '/leads', payload);
      flash('Lead captured!');
    }
    await loadAllData(true);
    updateNavCounts();
    document.getElementById('leadModal').classList.remove('open');
    renderKanban(getFilters());
    if (isAgent()) renderMyLeads();
    if (document.getElementById('page-overview').classList.contains('active')) renderKPIs();
  } catch (err) {
    flash(err.message || 'Failed to save lead', 'error');
  } finally {
    btnLoad(btn, false);
  }
});

/* ── New lead buttons ── */
document.getElementById('addLeadBtn')?.addEventListener('click',   () => openLeadModal(null));
document.getElementById('newLeadBtn')?.addEventListener('click',   () => openLeadModal(null));
document.getElementById('agentNewLeadBtn')?.addEventListener('click', () => openLeadModal(null));

/* ═══════════ CONFIRM / DELETE ═══════════ */
function confirmDelete(type, id, cb) {
  const modal = document.getElementById('confirmModal');
  document.getElementById('confirmTitle').textContent = type === 'lead' ? 'Delete this lead?' : 'Delete this product?';
  document.getElementById('confirmSub').textContent   = type === 'lead' ? 'Lead data and all follow-ups will be permanently removed.' : 'This product will be removed from all lead tags.';
  modal.classList.add('open');

  const okBtn = document.getElementById('confirmOk');
  const newOk = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);

  newOk.addEventListener('click', async () => {
    btnLoad(newOk, true, 'Deleting…');
    try {
      if (type === 'lead') {
        await api('DELETE', `/leads/${id}`);
      } else {
        await api('DELETE', `/products/${id}`);
      }
      await loadAllData(true);
      updateNavCounts();
      modal.classList.remove('open');
      document.getElementById('leadModal').classList.remove('open');
      renderKanban(getFilters());
      renderProductsTable();
      if (cb) cb();
      flash(type === 'lead' ? 'Lead deleted' : 'Product deleted', 'warn');
    } catch (err) {
      flash(err.message || 'Delete failed', 'error');
      btnLoad(newOk, false);
    }
  });
}

document.getElementById('confirmCancel').addEventListener('click', () => document.getElementById('confirmModal').classList.remove('open'));
document.getElementById('confirmModal').addEventListener('click', e => { if (e.target === document.getElementById('confirmModal')) document.getElementById('confirmModal').classList.remove('open'); });

/* ═══════════ AGENTS ═══════════ */
function renderAgentsGrid() {
  const grid = document.getElementById('agentsGrid');
  if (!grid) return;
  grid.innerHTML = S.agents.map(a => {
    const aLeads   = S.leads.filter(l => l.agentId === a.id);
    const won      = aLeads.filter(l => l.stage === 'won');
    const pipeline = aLeads.reduce((s,l) => s+(l.value||0),0);
    const convRate = aLeads.length ? ((won.length/aLeads.length)*100).toFixed(1) : '0.0';
    const tgtPct   = a.target ? Math.min(Math.round((pipeline/a.target)*100), 100) : 0;
    const inactive = a.status === 'inactive';
    return `
    <div class="agent-card ${inactive?'inactive-card':''}" style="--ac:${a.color}">
      <div class="agent-card-top">
        <div class="agent-avatar large" style="--ac:${a.color}">${a.initials}</div>
        <div class="agent-meta">
          <span class="agent-full-name">${a.name}</span>
          <span class="agent-designation">${a.designation}</span>
          <span class="agent-territory">📍 ${a.territory}</span>
        </div>
        <div class="agent-status-pill ${a.status === 'active'?'active':'inactive'}">${a.status.toUpperCase()}</div>
      </div>
      <div class="agent-kpis">
        <div class="ak"><span class="ak-val ${inactive?'dim':''}">${aLeads.length}</span><span class="ak-label">Total Leads</span></div>
        <div class="ak"><span class="ak-val green-text ${inactive?'dim':''}">${won.length}</span><span class="ak-label">Won</span></div>
        <div class="ak"><span class="ak-val ${inactive?'dim':''}">${convRate}%</span><span class="ak-label">Conv. Rate</span></div>
        <div class="ak"><span class="ak-val ${inactive?'dim':''}">${fmtValue(pipeline)}</span><span class="ak-label">Pipeline</span></div>
      </div>
      ${!inactive ? `
      <div class="agent-progress">
        <div class="ap-label"><span>Monthly Target</span><span>${fmtValue(pipeline)} / ${fmtValue(a.target)}</span></div>
        <div class="ap-bar"><div class="ap-fill" style="--pct:${tgtPct}%;--ac:${a.color}"></div></div>
      </div>` : ''}
      <div class="agent-card-actions">
        <button class="agent-btn" onclick="filterToAgent('${a.id}')">View Leads</button>
        ${a.status === 'active'
          ? `<button class="agent-btn danger" onclick="toggleAgent('${a.id}','inactive')">Deactivate</button>`
          : `<button class="agent-btn success" onclick="toggleAgent('${a.id}','active')">Reactivate</button>`}
        <button class="agent-btn" onclick="resetCreds('${a.id}')">Reset Creds</button>
        ${isSuperAdmin() ? `<button class="agent-btn danger hard-del-btn" onclick="hardDeleteAgent('${a.id}','${a.name.replace(/'/g,"\\'")}')">⚠ Hard Delete</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

window.filterToAgent = function(agentId) {
  goToPage('leads');
  setTimeout(() => {
    document.getElementById('filterAgent').value = agentId;
    renderKanban(getFilters());
  }, 50);
};

window.toggleAgent = async function(agentId, newStatus) {
  /* Find the clicked button by its onclick attribute context */
  showRefresh();
  try {
    await api('PUT', `/agents/${agentId}`, { status: newStatus });
    await loadAllData(true);
    renderAgentsGrid();
    flash(`Agent ${newStatus === 'active' ? 'reactivated' : 'deactivated'}`);
  } catch (err) {
    flash(err.message || 'Failed to update agent', 'error');
  } finally {
    hideRefresh();
  }
};

window.resetCreds = function(agentId) {
  const a = S.agents.find(x => x.id === agentId);
  if (a) flash(`Password reset link sent to: ${a.name}`);
};

/* ═══════════ PRODUCTS ═══════════ */
function renderProductsTable() {
  const tbody   = document.getElementById('productsTableBody');
  const empty   = document.getElementById('productsEmpty');
  const tbl     = document.getElementById('productsTable');
  if (!tbody) return;

  const search  = (document.getElementById('productSearch')?.value||'').toLowerCase();
  const catFilt = document.getElementById('filterProductCat')?.value||'';
  let prods = S.products.filter(p => {
    if (search && !p.name.toLowerCase().includes(search) && !p.sku.toLowerCase().includes(search)) return false;
    if (catFilt && p.category !== catFilt) return false;
    return true;
  });

  if (S.products.length === 0) {
    empty?.classList.remove('hidden');
    tbl?.classList.add('hidden');
    return;
  }
  empty?.classList.add('hidden');
  tbl?.classList.remove('hidden');

  prods = prods.map(p => ({
    ...p,
    interested: S.leads.filter(l => (l.products||[]).includes(p.id)).length
  }));

  tbody.innerHTML = prods.map(p => `
    <tr>
      <td><span class="product-sku">${p.sku}</span></td>
      <td>
        <div class="product-name">${p.name}</div>
        ${p.desc ? `<div style="font-size:10px;color:var(--text-4);font-family:var(--font-mono);margin-top:2px">${p.desc}</div>` : ''}
      </td>
      <td><span class="product-cat-badge ${p.category}">${p.category}</span></td>
      <td style="font-family:var(--font-display);font-weight:800;color:var(--text-1)">${fmtValue(p.price)}</td>
      <td>
        <span style="font-family:var(--font-display);font-weight:800;color:${p.interested>0?'var(--gold)':'var(--text-4)'}">${p.interested}</span>
        <span style="font-size:10px;color:var(--text-3);font-family:var(--font-mono)"> leads</span>
      </td>
      <td>
        <div class="table-actions">
          <button class="tbl-btn" onclick="openProductModal('${p.id}')">✎ Edit</button>
          <button class="tbl-btn del" onclick="confirmDelete('product','${p.id}')">🗑 Delete</button>
        </div>
      </td>
    </tr>`).join('');
}

document.getElementById('productSearch')?.addEventListener('input', renderProductsTable);
document.getElementById('filterProductCat')?.addEventListener('change', renderProductsTable);

/* ── Product Modal ── */
window.openProductModal = function(productId) {
  const modal  = document.getElementById('productModal');
  const isEdit = !!productId;
  document.getElementById('productModalEyebrow').textContent = isEdit ? '// EDIT PRODUCT' : '// ADD PRODUCT';
  document.getElementById('productModalTitle').innerHTML     = isEdit ? 'Edit <em>Product</em>' : 'New <em>Product</em>';
  document.getElementById('productSubmitBtn').textContent    = isEdit ? 'Save Changes →' : 'Add Product →';
  document.getElementById('productIdInput').value = productId || '';

  if (isEdit) {
    const p = S.products.find(x => x.id === productId);
    if (!p) return;
    document.getElementById('productName').value     = p.name;
    document.getElementById('productSKU').value      = p.sku;
    document.getElementById('productCategory').value = p.category;
    document.getElementById('productPrice').value    = p.price;
    document.getElementById('productDesc').value     = p.desc || '';
  } else {
    document.getElementById('productForm').reset();
  }
  modal.classList.add('open');
};

document.getElementById('addProductBtn')?.addEventListener('click', () => openProductModal(null));
document.getElementById('productModalClose').addEventListener('click',  () => document.getElementById('productModal').classList.remove('open'));
document.getElementById('productModalCancel').addEventListener('click', () => document.getElementById('productModal').classList.remove('open'));
document.getElementById('productModal').addEventListener('click', e => { if (e.target === document.getElementById('productModal')) document.getElementById('productModal').classList.remove('open'); });

document.getElementById('productForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id    = document.getElementById('productIdInput').value;
  const name  = document.getElementById('productName').value.trim();
  const sku   = document.getElementById('productSKU').value.trim();
  const cat   = document.getElementById('productCategory').value;
  const price = parseInt(document.getElementById('productPrice').value) || 0;
  const desc  = document.getElementById('productDesc').value.trim();
  if (!name || !sku || !cat) { flash('Name, SKU, and Category are required', 'error'); return; }
  const payload = { name, sku, category: cat, price, description: desc };
  const btn = document.getElementById('productSubmitBtn');
  btnLoad(btn, true, id ? 'Saving…' : 'Adding…');
  try {
    if (id) {
      await api('PUT', `/products/${id}`, payload);
      flash('Product updated');
    } else {
      await api('POST', '/products', payload);
      flash('Product added');
    }
    await loadAllData(true);
    updateNavCounts();
    document.getElementById('productModal').classList.remove('open');
    renderProductsTable();
    // Refresh lead product tags if lead modal is open
    const leadTagWrap = document.getElementById('leadProductTags');
    if (leadTagWrap && document.getElementById('leadModal').classList.contains('open')) {
      leadTagWrap.innerHTML = S.products.map(p =>
        `<label class="ptag-check" data-pid="${p.id}"><input type="checkbox" value="${p.id}"/><span>${p.name}</span></label>`
      ).join('');
    }
  } catch (err) {
    flash(err.message || 'Failed to save product', 'error');
  } finally {
    btnLoad(btn, false);
  }
});

/* ═══════════ EXPOS ═══════════ */
function renderExpos() {
  const grid = document.getElementById('expoGrid');
  if (!grid) return;
  grid.innerHTML = S.expos.map(e => {
    const cls  = e.status === 'live' ? 'live-expo' : e.status === 'upcoming' ? 'upcoming-expo' : 'past-expo';
    const chip = e.status === 'live' ? `<div class="expo-status-chip live-chip">● LIVE NOW</div>` : e.status === 'upcoming' ? `<div class="expo-status-chip upcoming-chip">◌ UPCOMING</div>` : `<div class="expo-status-chip past-chip">✓ COMPLETED</div>`;
    const agentChips = e.agents.slice(0,4).map(aid => {
      const a = agentById(aid);
      return a ? `<span class="expo-agent-chip" style="--ac:${a.color}">${a.initials}</span>` : '';
    }).join('') + (e.agents.length > 4 ? `<span class="expo-agent-chip" style="--ac:#888">+${e.agents.length-4}</span>` : '');
    const liveChart = e.status === 'live' ? `<div class="expo-hourly-label">Leads captured per hour (Today)</div><div class="expo-hourly-chart"><canvas id="expo_${e.id}_chart" height="80"></canvas></div>` : '';
    return `
    <div class="expo-card ${cls}">
      <div class="expo-card-header">${chip}<div class="expo-card-menu">⋯</div></div>
      <div class="expo-name">${e.name}</div>
      <div class="expo-sub-info">${e.dates} · ${e.venue}</div>
      <div class="expo-kpi-row">
        <div class="exp-kpi"><span class="exp-kpi-val" style="color:var(--gold)">${e.leadCount||'—'}</span><span class="exp-kpi-lbl">Leads</span></div>
        <div class="exp-kpi"><span class="exp-kpi-val" style="color:var(--emerald)">${e.converted||'—'}</span><span class="exp-kpi-lbl">Converted</span></div>
        <div class="exp-kpi"><span class="exp-kpi-val" style="color:var(--azure)">${e.agents.length}</span><span class="exp-kpi-lbl">Agents</span></div>
        ${e.leadCount > 0 ? `<div class="exp-kpi"><span class="exp-kpi-val" style="color:var(--amber)">${((e.converted/e.leadCount)*100).toFixed(1)}%</span><span class="exp-kpi-lbl">Conv.</span></div>` : ''}
      </div>
      ${liveChart}
      <div class="expo-agents-row">${agentChips}</div>
      <div class="expo-card-actions">
        ${e.status === 'live' ? `<button class="neo-btn yellow sm">Live Dashboard</button><button class="neo-btn outline sm">QR Mode</button>` : ''}
        ${e.status === 'upcoming' ? `<button class="neo-btn yellow sm">Edit Event</button><button class="neo-btn outline sm">Assign Agents</button>` : ''}
        ${e.status === 'past' ? `<button class="neo-btn outline sm">📄 Report</button><button class="neo-btn outline sm">📊 Compare</button>` : ''}
        <button class="neo-btn outline sm" onclick="openReferrerModal('${e.id}','${e.name.replace(/'/g,"\\'")}')">👥 Referrers</button>
      </div>
    </div>`;
  }).join('');

  S.expos.filter(e => e.status === 'live').forEach(e => {
    const ctx = document.getElementById(`expo_${e.id}_chart`);
    if (!ctx) return;
    new Chart(ctx, {
      type:'bar',
      data:{ labels:['9AM','10AM','11AM','12PM','1PM','2PM','3PM','4PM','5PM','6PM'], datasets:[{ data:[12,28,34,24,18,42,38,30,26,14], backgroundColor: ctx => { const v=ctx.raw; if(v>=40) return '#F0BE18'; if(v>=25) return '#00DFA2'; return '#2a2a2a'; }, borderColor:'transparent', borderRadius:0 }] },
      options:{ responsive:true, plugins:{ legend:{display:false}, tooltip:{backgroundColor:'#161616',borderColor:'#333',borderWidth:1,callbacks:{label:c=>` ${c.raw} leads`}} }, scales:{ x:{grid:{display:false},ticks:{color:'#444',font:{size:9}}}, y:{grid:{color:'#1a1a1a'},ticks:{color:'#444',font:{size:9}}} }, animation:{duration:1000} }
    });
  });
}

/* ═══════════ AGENT VIEW: MY LEADS & STATS ═══════════ */
function renderMyLeads() {
  if (!S.session?.agentId) return;
  const myLeads = S.leads.filter(l => l.agentId === S.session.agentId);
  renderKanban({}, 'myKanbanBoard', myLeads);
}

function renderMyStats() {
  const grid = document.getElementById('myStatsGrid');
  if (!grid || !S.session?.agentId) return;
  const me = agentById(S.session.agentId);
  const myLeads = S.leads.filter(l => l.agentId === S.session.agentId);
  const won = myLeads.filter(l => l.stage === 'won');
  const pipeline = myLeads.reduce((s,l)=>s+(l.value||0),0);
  const convRate = myLeads.length ? ((won.length/myLeads.length)*100).toFixed(1) : '0.0';
  const overdue  = myLeads.filter(l => !['won','lost'].includes(l.stage) && daysSince(l.lastContact)>7);
  grid.innerHTML = `
    <div class="my-stat-big highlight">
      <div class="kpi-label">MY TOTAL LEADS</div>
      <div class="kpi-value" style="font-size:clamp(28px,3vw,40px)">${myLeads.length}</div>
      <div class="kpi-sub">Assigned to you</div>
    </div>
    <div class="my-stat-big" style="border-color:var(--emerald)">
      <div class="kpi-label">CONVERSION RATE</div>
      <div class="kpi-value" style="font-size:clamp(28px,3vw,40px);color:var(--emerald)">${convRate}%</div>
      <div class="kpi-sub">${won.length} won of ${myLeads.length}</div>
    </div>
    <div class="my-stat-big" style="border-color:var(--azure)">
      <div class="kpi-label">PIPELINE VALUE</div>
      <div class="kpi-value" style="font-size:clamp(28px,3vw,40px);color:var(--azure)">${fmtValue(pipeline)}</div>
      <div class="kpi-sub">Active deals</div>
    </div>
    <div class="my-stat-big" style="border-color:var(--coral)">
      <div class="kpi-label">OVERDUE FOLLOW-UPS</div>
      <div class="kpi-value" style="font-size:clamp(28px,3vw,40px);color:var(--coral)">${overdue.length}</div>
      <div class="kpi-sub">⚠ Needs attention</div>
    </div>
    <div class="card span-2" style="border-color:var(--amber);grid-column:span 2">
      <div class="card-title-group" style="margin-bottom:16px">
        <span class="card-eyebrow">// MONTHLY TARGET</span>
        <h2 class="card-title">${me ? 'Progress vs Target' : ''}</h2>
      </div>
      ${me ? `
      <div class="ap-label" style="font-family:var(--font-mono);font-size:10px;color:var(--text-3);display:flex;justify-content:space-between;margin-bottom:8px">
        <span>${fmtValue(pipeline)}</span><span>Target: ${fmtValue(me.target)}</span>
      </div>
      <div class="ap-bar" style="height:8px">
        <div class="ap-fill" style="--pct:${Math.min(Math.round((pipeline/me.target)*100),100)}%;--ac:var(--amber)"></div>
      </div>
      <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-3);margin-top:6px">${Math.min(Math.round((pipeline/me.target)*100),100)}% of monthly target achieved</div>
      ` : ''}
    </div>`;
}

/* ═══════════ BULK IMPORT ═══════════ */
let wizardStep = 1;
function goWizardStep(step) {
  for (let i=1;i<=4;i++) {
    document.getElementById(`wzPanel${i}`)?.classList.toggle('hidden', i!==step);
    const wz = document.getElementById(`wz${i}`);
    if (wz) {
      wz.classList.toggle('active', i===step);
      wz.classList.toggle('done', i<step);
    }
  }
  wizardStep = step;
}
window.goWizardStep = goWizardStep;

document.getElementById('bulkImportBtn')?.addEventListener('click', () => {
  goWizardStep(1);
  S.csvParsed = [];
  document.getElementById('csvPasteArea').value = '';
  document.getElementById('csvUploadError').classList.add('hidden');
  document.getElementById('bulkImportModal').classList.add('open');
});
document.getElementById('bulkImportClose')?.addEventListener('click', () => document.getElementById('bulkImportModal').classList.remove('open'));

document.getElementById('downloadTemplateBtn')?.addEventListener('click', () => {
  const header  = 'name,phone,email,source,expo,products,value,notes';
  const example = 'Rajesh Sharma,+91 98200 00000,raj@example.com,expo,Pune Realty Expo 2025,PRD-001|PRD-002,250000,Met at booth 14';
  const blob = new Blob([header+'\n'+example], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'iinvsys_leads_template.csv';
  a.click();
});

const dropZone = document.getElementById('csvDropZone');
dropZone?.addEventListener('click', () => document.getElementById('csvFileInput').click());
dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone?.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) readCSVFile(file);
});
document.getElementById('csvFileInput')?.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) readCSVFile(file);
});
function readCSVFile(file) {
  const reader = new FileReader();
  reader.onload = ev => { document.getElementById('csvPasteArea').value = ev.target.result; };
  reader.readAsText(file);
}

document.getElementById('parseCSVBtn')?.addEventListener('click', () => {
  const raw = document.getElementById('csvPasteArea').value.trim();
  const err = document.getElementById('csvUploadError');
  if (!raw) { err.textContent = 'Please upload a file or paste CSV text'; err.classList.remove('hidden'); return; }
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) { err.textContent = 'CSV must have at least a header row and one data row'; err.classList.remove('hidden'); return; }

  const header   = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g,''));
  const REQ_COLS = ['name','phone','source'];
  const missing  = REQ_COLS.filter(c => !header.includes(c));
  if (missing.length) { err.textContent = `Missing required columns: ${missing.join(', ')}`; err.classList.remove('hidden'); return; }
  err.classList.add('hidden');

  const rows = [];
  const errors = [];
  lines.slice(1).forEach((line, i) => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g,''));
    const row  = {};
    header.forEach((h,j) => { row[h] = vals[j]||''; });
    if (!row.name)   { errors.push(`Row ${i+2}: Missing name`);   return; }
    if (!row.phone)  { errors.push(`Row ${i+2}: Missing phone`);  return; }
    if (!row.source) { errors.push(`Row ${i+2}: Missing source`); return; }
    row._dup = !!S.leads.find(l => l.phone === row.phone);
    rows.push(row);
  });

  S.csvParsed = rows;
  const good = rows.filter(r => !r._dup).length;
  const dups  = rows.filter(r => r._dup).length;
  document.getElementById('previewSummary').innerHTML =
    `<strong style="color:var(--gold)">${rows.length}</strong> rows parsed &nbsp;|&nbsp; `+
    `<strong style="color:var(--emerald)">${good}</strong> new &nbsp;|&nbsp; `+
    `<strong style="color:var(--coral)">${dups}</strong> duplicates (will be skipped) `+
    (errors.length ? `&nbsp;|&nbsp; <strong style="color:var(--coral)">${errors.length}</strong> errors` : '');

  const previewHead = document.getElementById('csvPreviewHead');
  const previewBody = document.getElementById('csvPreviewBody');
  const dispCols    = header.slice(0,5);
  previewHead.innerHTML = `<tr>${dispCols.map(c=>`<th>${c}</th>`).join('')}<th>Status</th></tr>`;
  previewBody.innerHTML = rows.slice(0,8).map(r =>
    `<tr>${dispCols.map(c=>`<td style="font-size:11px;padding:8px 14px;border-bottom:1px solid var(--surface-3);color:var(--text-2)">${r[c]||'—'}</td>`).join('')}
     <td style="padding:8px 14px"><span class="act-tag ${r._dup?'overdue':'won'}">${r._dup?'DUP':'NEW'}</span></td></tr>`
  ).join('');
  goWizardStep(3);
});

document.getElementById('confirmImportBtn')?.addEventListener('click', async () => {
  const toImport = S.csvParsed.filter(r => !r._dup);
  const leads = toImport.map(r => {
    const products = (r.products||'').split('|').map(s=>s.trim()).filter(Boolean)
      .map(sku => S.products.find(p=>p.sku===sku)?.id).filter(Boolean);
    return {
      name: r.name, phone: r.phone, email: r.email||'',
      source: r.source||'direct', stage: 'new',
      assignedAgent: S.agents.find(a=>a.status==='active')?.id,
      products, value: parseInt(r.value)||0,
      notes: r.notes||'',
    };
  });
  const btn = document.getElementById('confirmImportBtn');
  btnLoad(btn, true, 'Importing…');
  try {
    const res = await api('POST', '/leads/bulk-import', { leads });
    await loadAllData(true);
    updateNavCounts();
    renderKanban(getFilters());
    if (document.getElementById('page-overview').classList.contains('active')) renderKPIs();
    const imported = res.data?.imported ?? toImport.length;
    const skipped  = res.data?.skipped  ?? S.csvParsed.filter(r=>r._dup).length;
    document.getElementById('importResults').innerHTML = `
      <div class="import-result-icon">✅</div>
      <div class="import-result-title">${imported} Leads Imported</div>
      <div class="import-result-sub">${skipped} duplicates skipped · All leads assigned to active agents</div>`;
    goWizardStep(4);
  } catch(err) {
    flash(err.message || 'Import failed', 'error');
  } finally {
    btnLoad(btn, false);
  }
});

document.getElementById('doneImportBtn')?.addEventListener('click', () => {
  document.getElementById('bulkImportModal').classList.remove('open');
});

/* ═══════════ ANALYTICS CHARTS ═══════════ */
Chart.defaults.color = '#666';
Chart.defaults.borderColor = '#1e1e1e';
let analyticsInit = false;
function initAnalyticsCharts() {
  if (analyticsInit) return;
  analyticsInit = true;
  const CLRS = { gold:'#F0BE18', emerald:'#00DFA2', coral:'#FF3D1F', azure:'#2979FF', amber:'#FF8C00', violet:'#AA00FF' };
  const months = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];

  const mainCtx = document.getElementById('analyticsMainChart');
  if (mainCtx) new Chart(mainCtx, {
    type:'bar',
    data:{ labels:months, datasets:[
      { label:'New Leads', data:[84,92,78,110,124,98,140,132,158,146,172,S.leads.length], backgroundColor:'rgba(41,121,255,0.5)', borderColor:CLRS.azure, borderWidth:1, yAxisID:'y' },
      { label:'Revenue (₹L)', data:[4.2,5.1,3.8,6.4,7.2,5.8,8.4,8.1,10.2,9.4,11.8,14.2], type:'line', borderColor:CLRS.gold, backgroundColor:'rgba(240,190,24,0.06)', fill:true, tension:0.4, borderWidth:2, pointBackgroundColor:CLRS.gold, pointRadius:4, yAxisID:'y1' }
    ]},
    options:{ responsive:true, interaction:{mode:'index',intersect:false}, plugins:{ legend:{labels:{color:'#666',boxWidth:10}}, tooltip:{backgroundColor:'#161616',borderColor:'#333',borderWidth:1} }, scales:{ y:{position:'left',grid:{color:'#1a1a1a'},ticks:{color:'#444',font:{size:10}}}, y1:{position:'right',grid:{drawOnChartArea:false},ticks:{color:'#444',font:{size:10},callback:v=>`₹${v}L`}}, x:{grid:{color:'#1a1a1a'},ticks:{color:'#444',font:{size:10}}} }, animation:{duration:1200} }
  });

  const prodCtx = document.getElementById('productChart');
  if (prodCtx) {
    const prodData   = S.products.slice(0,5).map(p => S.leads.filter(l=>(l.products||[]).includes(p.id)).length);
    const prodLabels = S.products.slice(0,5).map(p => p.name);
    new Chart(prodCtx, {
      type:'bar',
      data:{ labels:prodLabels, datasets:[{ data:prodData, backgroundColor:[CLRS.gold,CLRS.azure,CLRS.emerald,CLRS.amber,CLRS.violet], borderColor:'transparent' }] },
      options:{ indexAxis:'y', responsive:true, plugins:{legend:{display:false},tooltip:{backgroundColor:'#161616',borderColor:'#333',borderWidth:1,callbacks:{label:c=>` ${c.raw} leads`}}}, scales:{x:{grid:{color:'#1a1a1a'},ticks:{color:'#444',font:{size:10}}},y:{grid:{display:false},ticks:{color:'#888',font:{size:10}}}}, animation:{duration:1200} }
    });
  }

  const lostCtx = document.getElementById('lostReasonsChart');
  if (lostCtx) new Chart(lostCtx, {
    type:'doughnut',
    data:{ labels:['Budget Constraint','Competition','Not Ready','Bad Timing','No Interest'], datasets:[{ data:[38,24,18,12,8], backgroundColor:[CLRS.coral,CLRS.amber,CLRS.azure,CLRS.violet,'#444'], borderColor:'#0f0f0f', borderWidth:3, hoverOffset:8 }] },
    options:{ cutout:'60%', plugins:{ legend:{display:true,position:'bottom',labels:{color:'#666',boxWidth:10,font:{size:9},padding:10}}, tooltip:{backgroundColor:'#161616',borderColor:'#333',borderWidth:1} }, animation:{animateScale:true,duration:1200} }
  });
}

/* ═══════════ FLASH TOAST ═══════════ */
function flash(msg, type='success') {
  const existing = document.getElementById('flashToast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'flashToast';
  el.textContent = msg;
  const bg = type === 'error' ? 'var(--coral)' : type === 'warn' ? 'var(--amber)' : 'var(--emerald)';
  el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;background:${bg};color:#000;padding:10px 18px;font-family:var(--font-display);font-size:12px;font-weight:800;letter-spacing:0.5px;border:2px solid #000;box-shadow:4px 4px 0 #000;animation:kpiIn 0.3s ease forwards;`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

/* ═══════════ KEYBOARD SHORTCUTS ═══════════ */
document.addEventListener('keydown', e => {
  if (!S.session) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (isAdmin()) {
    switch(e.key) {
      case '1': goToPage('overview');  break;
      case '2': goToPage('leads');     break;
      case '3': goToPage('agents');    break;
      case '4': goToPage('products');  break;
      case '5': goToPage('expos');     break;
      case '6': goToPage('analytics'); break;
      case 'n': case 'N': openLeadModal(null); break;
      case 'Escape': closeAllModals(); break;
    }
  } else {
    switch(e.key) {
      case '1': goToPage('myLeads'); break;
      case '2': goToPage('myStats'); break;
      case 'n': case 'N': openLeadModal(null); break;
      case 'Escape': closeAllModals(); break;
    }
  }
});

function closeAllModals() {
  ['leadModal','bulkImportModal','productModal','confirmModal','referrerModal'].forEach(id => {
    document.getElementById(id)?.classList.remove('open');
  });
}

/* ═══════════ AUTO-LOGIN (session restore on page reload) ═══════════ */
(async function tryAutoLogin() {
  if (!_token) return;
  showLoader('Restoring session…');
  try {
    const res = await api('GET', '/auth/me');
    const u   = res.data.user || res.data;
    S.session = { ...u, id: u._id || u.id };
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    await initApp();
  } catch (err) {
    hideLoader();
    _token = null;
    localStorage.removeItem('ii_token');
  }
})();

/* ═══════════ SETTINGS PAGE ═══════════ */
async function renderSettings() {
  const wrap = document.getElementById('settingsGroups');
  if (!wrap) return;
  wrap.innerHTML = contentSpinner('Loading settings…');
  try {
    const res = await api('GET', '/settings');
    const settings = res.data || [];

    const groups = {};
    settings.forEach(s => {
      if (!groups[s.group]) groups[s.group] = [];
      groups[s.group].push(s);
    });

    const groupLabels = { general:'General', company:'Company', lead:'Lead Pipeline', product:'Products', agent:'Agents', expo:'Expos', system:'System' };

    wrap.innerHTML = Object.entries(groups).map(([grp, items]) => `
      <section class="settings-group">
        <div class="settings-group-header">// ${(groupLabels[grp] || grp).toUpperCase()}</div>
        ${items.map(s => `
        <div class="settings-row" data-key="${s.key}">
          <div class="settings-label-col">
            <div class="settings-key">${s.label || s.key}</div>
            ${s.description ? `<div class="settings-desc">${s.description}</div>` : ''}
          </div>
          <div class="settings-val-col">
            ${renderSettingInput(s)}
          </div>
          ${isSuperAdmin() ? `<button class="agent-btn" onclick="saveSetting('${s.key}',this)">Save</button>` : ''}
        </div>`).join('')}
      </section>`).join('');
  } catch (err) {
    wrap.innerHTML = `<div style="font-family:var(--font-mono);font-size:11px;color:var(--coral);padding:24px">Failed to load settings: ${err.message}</div>`;
  }
}

function renderSettingInput(s) {
  const readonly = !isSuperAdmin() ? 'readonly disabled style="opacity:0.5"' : '';
  const val = Array.isArray(s.value) ? s.value.join(', ') : s.value;
  if (s.type === 'boolean') {
    return `<label class="settings-toggle">
      <input type="checkbox" data-key="${s.key}" ${s.value ? 'checked' : ''} ${readonly ? 'disabled' : ''} onchange="if(!${isSuperAdmin()})return;"/>
      <span class="toggle-track"></span>
    </label>`;
  }
  if (s.type === 'array') {
    return `<input type="text" class="form-input settings-input" data-key="${s.key}" value="${val}" placeholder="Comma-separated values" ${readonly}/>`;
  }
  return `<input type="${s.type === 'number' ? 'number' : 'text'}" class="form-input settings-input" data-key="${s.key}" value="${val}" ${readonly}/>`;
}

window.saveSetting = async function(key, btn) {
  const row   = btn.closest('.settings-row');
  const input = row.querySelector(`[data-key="${key}"]`);
  if (!input) return;
  let value = input.type === 'checkbox' ? input.checked : input.value;
  const originalType = input.dataset.type;
  if (typeof value === 'string' && value.includes(',') && !value.startsWith('{')) {
    value = value.split(',').map(s => s.trim()).filter(Boolean);
  } else if (input.type === 'number') {
    value = Number(value);
  }
  btnLoad(btn, true, '…');
  try {
    await api('PUT', '/settings', { updates: [{ key, value }] });
    flash(`Setting saved`);
  } catch(err) {
    flash(err.message || 'Failed to save setting', 'error');
  } finally {
    btnLoad(btn, false);
  }
};

/* ═══════════ REFERRER VIEW ═══════════ */
function renderReferrerView() {
  const wrap = document.getElementById('referrerView');
  if (!wrap) return;

  const expoName = S.session?.expoId
    ? (S.expos.find(e => e.id === S.session?.expoId)?.name || 'Your Expo')
    : 'Your Expo';

  wrap.innerHTML = `
    <div class="referrer-hero">
      <div class="referrer-expo-badge">◇ ${expoName}</div>
      <div class="referrer-welcome">Ready to capture leads?</div>
    </div>
    <div class="referrer-form-card">
      <form id="referrerLeadForm">
        <div class="referrer-camera-row">
          <button type="button" class="neo-btn outline full-w" id="refCameraBtn">📷 Scan Business Card</button>
          <input type="file" id="refCardInput" accept="image/*" capture="environment" style="display:none"/>
        </div>
        <div class="ref-divider">— or enter manually —</div>
        <div class="form-group">
          <label class="form-label">Full Name <span class="req">*</span></label>
          <input type="text" id="refLeadName" class="form-input" placeholder="e.g. Rajesh Sharma" autocomplete="name"/>
        </div>
        <div class="form-group">
          <label class="form-label">Phone <span class="req">*</span></label>
          <input type="tel" id="refLeadPhone" class="form-input" placeholder="+91 98200 00000" autocomplete="tel"/>
        </div>
        <div class="form-group">
          <label class="form-label">Email <span class="opt">(optional)</span></label>
          <input type="email" id="refLeadEmail" class="form-input" placeholder="email@example.com" autocomplete="email"/>
        </div>
        <div class="form-group">
          <label class="form-label">Company <span class="opt">(optional)</span></label>
          <input type="text" id="refLeadCompany" class="form-input" placeholder="Company name"/>
        </div>
        <div class="form-group">
          <label class="form-label">Notes <span class="opt">(optional)</span></label>
          <textarea id="refLeadNotes" class="form-input" rows="2" placeholder="Product interest, booth interaction…"></textarea>
        </div>
        <button type="submit" class="neo-btn yellow full-w" id="refLeadSubmit" style="padding:16px;font-size:14px;margin-top:8px">
          Capture Lead →
        </button>
      </form>
      <div id="refTodayCount" class="ref-today-count"><!-- rendered after submit --></div>
    </div>`;

  /* Camera / OCR for referrer form */
  document.getElementById('refCameraBtn')?.addEventListener('click', () => {
    document.getElementById('refCardInput').click();
  });
  document.getElementById('refCardInput')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) processCardImage(file, { name:'refLeadName', phone:'refLeadPhone', email:'refLeadEmail', notes:'refLeadNotes' });
  });

  document.getElementById('referrerLeadForm')?.addEventListener('submit', async ev => {
    ev.preventDefault();
    const name  = document.getElementById('refLeadName').value.trim();
    const phone = document.getElementById('refLeadPhone').value.trim();
    if (!name || !phone) { flash('Name and phone are required', 'error'); return; }

    const company = document.getElementById('refLeadCompany').value.trim();
    const notes   = document.getElementById('refLeadNotes').value.trim();
    const payload = {
      name, phone,
      email:  document.getElementById('refLeadEmail').value.trim(),
      stage:  'new',
      source: 'expo',
      notes:  company ? `[${company}] ${notes}` : notes,
    };
    const btn = document.getElementById('refLeadSubmit');
    btnLoad(btn, true, 'Capturing…');
    try {
      await api('POST', '/leads', payload);
      document.getElementById('referrerLeadForm').reset();
      flash('Lead captured!');
      S._refCount = (S._refCount || 0) + 1;
      const countEl = document.getElementById('refTodayCount');
      if (countEl) countEl.innerHTML = `<span class="ref-count-badge">${S._refCount} lead${S._refCount > 1 ? 's' : ''} captured today ✓</span>`;
    } catch (err) {
      flash(err.message || 'Failed to save lead', 'error');
    } finally {
      btnLoad(btn, false);
    }
  });
}

/* ═══════════ REFERRER MANAGEMENT MODAL ═══════════ */
let _currentReferrerExpoId = null;

window.openReferrerModal = async function(expoId, expoName) {
  _currentReferrerExpoId = expoId;
  document.getElementById('referrerModalTitle').innerHTML = `<em>${expoName}</em> Referrers`;
  document.getElementById('refName').value     = '';
  document.getElementById('refPassword').value = '';
  document.getElementById('refCredsBanner').classList.add('hidden');
  document.getElementById('referrerModal').classList.add('open');
  await loadReferrerList(expoId);
};

async function loadReferrerList(expoId) {
  const list = document.getElementById('referrerList');
  if (!list) return;
  list.innerHTML = contentSpinner('Loading referrers…');
  try {
    const res = await api('GET', `/expos/${expoId}/referrers`);
    const referrers = res.data || [];
    if (referrers.length === 0) {
      list.innerHTML = `<div class="referrer-empty">No referrers yet. Create one above.</div>`;
      return;
    }
    list.innerHTML = referrers.map(r => {
      const exp = r.expiresAt ? new Date(r.expiresAt).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) : '—';
      const active = !r.expiresAt || new Date() < new Date(r.expiresAt);
      return `<div class="referrer-item">
        <div class="referrer-item-info">
          <span class="referrer-item-name">${r.name}</span>
          <span class="referrer-item-meta">${r.email}</span>
          <span class="referrer-item-meta">Expires: ${exp} · ${r.leadCount || 0} leads · <span style="color:${active?'var(--emerald)':'var(--coral)'}">${active?'Active':'Expired'}</span></span>
        </div>
        <button class="agent-btn danger" onclick="deleteReferrer('${expoId}','${r._id}')">Delete</button>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div style="font-family:var(--font-mono);font-size:11px;color:var(--coral);padding:12px">${err.message}</div>`;
  }
}

document.getElementById('createReferrerBtn')?.addEventListener('click', async () => {
  const name = document.getElementById('refName').value.trim();
  const pass = document.getElementById('refPassword').value.trim();
  if (!name || !pass) { flash('Name and password are required', 'error'); return; }
  const btn = document.getElementById('createReferrerBtn');
  btnLoad(btn, true, 'Creating…');
  try {
    const res = await api('POST', `/expos/${_currentReferrerExpoId}/referrers`, { name, password: pass });
    const creds = res.data;
    document.getElementById('refCredsEmail').textContent = creds.email;
    document.getElementById('refCredsPass').textContent  = creds.password;
    document.getElementById('refCredsBanner').classList.remove('hidden');
    document.getElementById('refName').value     = '';
    document.getElementById('refPassword').value = '';
    await loadReferrerList(_currentReferrerExpoId);
    flash('Referrer account created');
  } catch (err) {
    flash(err.message || 'Failed to create referrer', 'error');
  } finally {
    btnLoad(btn, false);
  }
});

document.getElementById('copyEmailBtn')?.addEventListener('click', () => {
  navigator.clipboard?.writeText(document.getElementById('refCredsEmail').textContent).then(() => flash('Email copied'));
});
document.getElementById('copyPassBtn')?.addEventListener('click', () => {
  navigator.clipboard?.writeText(document.getElementById('refCredsPass').textContent).then(() => flash('Password copied'));
});

window.deleteReferrer = async function(expoId, uid) {
  if (!confirm('Delete this referrer account permanently?')) return;
  showRefresh();
  try {
    await api('DELETE', `/expos/${expoId}/referrers/${uid}`);
    await loadReferrerList(expoId);
    flash('Referrer deleted', 'warn');
  } catch (err) {
    flash(err.message || 'Delete failed', 'error');
  } finally {
    hideRefresh();
  }
};

document.getElementById('referrerModalClose')?.addEventListener('click', () => document.getElementById('referrerModal').classList.remove('open'));
document.getElementById('referrerModal')?.addEventListener('click', e => { if (e.target === document.getElementById('referrerModal')) document.getElementById('referrerModal').classList.remove('open'); });

/* ═══════════ AGENT HARD DELETE ═══════════ */
window.hardDeleteAgent = function(agentId, agentName) {
  const modal = document.getElementById('confirmModal');
  document.getElementById('confirmTitle').textContent = `Hard delete "${agentName}"?`;
  document.getElementById('confirmSub').textContent   = 'This permanently removes the agent, their user account, and unassigns all their leads. This CANNOT be undone.';
  modal.classList.add('open');

  const okBtn  = document.getElementById('confirmOk');
  const newOk  = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);

  newOk.addEventListener('click', async () => {
    btnLoad(newOk, true, 'Deleting…');
    try {
      await api('DELETE', `/agents/${agentId}/hard`);
      await loadAllData(true);
      updateNavCounts();
      modal.classList.remove('open');
      renderAgentsGrid();
      flash(`Agent "${agentName}" permanently deleted`, 'warn');
    } catch (err) {
      flash(err.message || 'Delete failed', 'error');
      btnLoad(newOk, false);
    }
  });
};

/* ═══════════ CAMERA / OCR ═══════════ */
async function processCardImage(file, fieldMap) {
  /* Disable whichever scan button triggered this */
  const scanBtns = [
    document.getElementById('cameraScanBtn'),
    document.getElementById('refCameraBtn'),
  ];
  scanBtns.forEach(b => btnLoad(b, true, '🔍 Scanning…'));
  showRefresh();
  try {
    const result = await Tesseract.recognize(file, 'eng', { logger: () => {} });
    const text = result.data.text;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    /* Extract fields with regex */
    const phoneMatch = text.match(/(?:\+91[-\s]?)?[6-9]\d{9}/);
    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);

    /* Name: first non-empty line that isn't phone/email/URL */
    const nameLine = lines.find(l => l.length > 2 && l.length < 50 && !l.match(/[@\d\/\\]/) && !l.toLowerCase().includes('www'));
    /* Company: line with Ltd/Pvt/Inc/Corp or second substantial line */
    const companyLine = lines.find(l => /ltd|pvt|inc|corp|llp|solutions|technologies|services|group/i.test(l));

    if (fieldMap.name && nameLine)              document.getElementById(fieldMap.name).value  = nameLine;
    if (fieldMap.phone && phoneMatch)           document.getElementById(fieldMap.phone).value = phoneMatch[0];
    if (fieldMap.email && emailMatch)           document.getElementById(fieldMap.email).value = emailMatch[0];
    if (fieldMap.company && companyLine)        document.getElementById(fieldMap.company).value = companyLine;
    if (fieldMap.notes && !fieldMap.company)    document.getElementById(fieldMap.notes).value  = text.substring(0, 200);

    flash('Card scanned — review and confirm the details');
  } catch (err) {
    flash('Could not read card — please fill in manually', 'error');
  } finally {
    scanBtns.forEach(b => btnLoad(b, false));
    hideRefresh();
  }
}

/* Wire up the lead modal camera button */
document.getElementById('cameraScanBtn')?.addEventListener('click', () => {
  document.getElementById('cardCameraInput').click();
});
document.getElementById('cardCameraInput')?.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) processCardImage(file, { name:'leadName', phone:'leadPhone', email:'leadEmail' });
  e.target.value = ''; // reset so same file can re-trigger
});

console.log('%c IINVSYS Sales OS v2.0 ', 'background:#F0BE18;color:#000;font-weight:bold;padding:4px 12px;letter-spacing:2px');
console.log('%c API: http://localhost:5001/api  ·  MongoDB: live', 'color:#00DFA2;font-size:11px');
console.log('%c Keyboard: 1-6 navigate · N = new lead · Esc = close modal', 'color:#555;font-size:11px');
console.log('%c Logins: admin@iinvsys.com / Admin@123  |  rahul@iinvsys.com / Agent@123', 'color:#888;font-size:10px');
