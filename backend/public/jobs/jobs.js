'use strict';
// Aushilfen-App (PWA). Alle Ausgaben via textContent/el() – kein innerHTML → kein XSS.
const API = '/api/v1';
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignorieren */ } },
};
const json = (k, d) => { try { return JSON.parse(store.get(k)) ?? d; } catch { return d; } };
const state = { me: null, deck: [], pos: null, busy: false, apps: [] };
const SKILL = { BAR: 'Bar', SERVICE: 'Service', KITCHEN: 'Küche', DISHWASHING: 'Spülküche' };

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === 'class' ? (n.className = v) : k.startsWith('on') ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v);
  for (const c of children) n.append(c);
  return n;
}
function show(text, ok = false) {
  const m = $('msg'); m.textContent = text; m.className = 'msg' + (ok ? ' ok' : ''); m.hidden = !text;
  if (text) window.scrollTo({ top: 0, behavior: 'smooth' });
}
const errorText = (b) => (b && b.issues ? b.issues.map((i) => i.message).join(' · ') : (b && b.message) || 'Unbekannter Fehler');
async function api(path, { method = 'GET', body } = {}) {
  const t = store.get('jobs_token');
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  let data = null; try { data = await res.json(); } catch { /* leer */ }
  if (res.status === 401 && t) { logout(); throw new Error('Sitzung abgelaufen – bitte erneut anmelden'); }
  if (res.status === 429) throw new Error('Zu viele Anfragen – bitte kurz warten');
  if (!res.ok) throw new Error(errorText(data));
  return data;
}
async function busy(btn, fn) { btn.disabled = true; show(''); try { await fn(); } catch (e) { show(e.message); } finally { btn.disabled = false; } }
const fmtTime = (iso) => new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const euro = (c) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

// ---- Ansichten ----
function view(name) {
  $('landing').hidden = name !== 'landing'; $('auth').hidden = name !== 'auth'; $('appview').hidden = name !== 'app';
  const inApp = name === 'app';
  $('guestbox').hidden = inApp; $('userbox').hidden = !inApp; $('nav').hidden = inApp; $('tabbar').hidden = !inApp;
  document.body.classList.toggle('in-app', inApp);
  window.scrollTo({ top: 0 });
}
function logout() { store.set('jobs_token', null); state.me = null; state.deck = []; view('landing'); }
function tab(login) {
  $('loginForm').hidden = !login; $('registerForm').hidden = login;
  $('tabLogin').classList.toggle('active', login); $('tabRegister').classList.toggle('active', !login); show('');
}
function openAuth(login) { view('auth'); tab(login); }
$('goLogin').onclick = () => openAuth(true);
$('goRegister').onclick = () => openAuth(false);
$('ctaRegister').onclick = () => openAuth(false);
$('tabLogin').onclick = () => tab(true);
$('tabRegister').onclick = () => tab(false);
$('logout').onclick = logout;
$('home').addEventListener('click', (e) => { e.preventDefault(); if (!store.get('jobs_token')) view('landing'); });

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
  busy(e.submitter, async () => { store.set('jobs_token', (await api('/auth/login', { method: 'POST', body: f })).token); await start(); });
});
$('registerForm').addEventListener('submit', (e) => {
  e.preventDefault(); const fd = new FormData(e.target); const f = Object.fromEntries(fd);
  busy(e.submitter, async () => {
    const res = await api('/freelancers/register', { method: 'POST', body: { ...f, skills: fd.getAll('skills'), privacyConsent: fd.has('privacyConsent') } });
    store.set('jobs_token', res.token); await start();
  });
});

// ---- Tabs der App ----
document.querySelectorAll('#tabbar button').forEach((b) => b.addEventListener('click', () => {
  show('');
  document.querySelectorAll('#tabbar button').forEach((x) => x.classList.toggle('on', x === b));
  for (const id of ['tabShifts', 'tabApps', 'tabProfile']) $(id).hidden = id !== b.dataset.tab;
  if (b.dataset.tab === 'tabApps') { $('appBadge').hidden = true; loadApps().catch((e) => show(e.message)); }
  if (b.dataset.tab === 'tabProfile') renderProfile();
}));

// ---- Wisch-Karten ----
function shiftCard(s, top) {
  const hours = (new Date(s.endTime) - new Date(s.startTime)) / 3.6e6;
  const c = el('div', { class: 'swipe' + (top ? '' : ' next') },
    el('span', { class: 'pill dist' }, `${Number(s.distanceKm).toLocaleString('de-DE', { maximumFractionDigits: 1 })} km`),
    el('div', { class: 'stampyes' }, 'INTERESSE'), el('div', { class: 'stampno' }, 'NEIN'),
    el('div', { class: 'role' }, s.role), el('div', { class: 'where' }, `${s.restaurantName} · ${s.city}`),
    el('div', { class: 'rate' }, `${euro(s.hourlyRateCents)}/Std.`),
    el('div', { class: 'est' }, `≈ ${euro(Math.round(hours * s.hourlyRateCents))} brutto für ${hours.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Std.`),
    el('div', { class: 'when' }, `${fmtTime(s.startTime)} – ${new Date(s.endTime).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`),
    s.requirements ? el('div', { class: 'req' }, s.requirements) : '');
  if (top) attachDrag(c);
  return c;
}
function attachDrag(c) {
  let x0 = null, dx = 0;
  c.addEventListener('pointerdown', (e) => { if (state.busy) return; x0 = e.clientX; c.setPointerCapture(e.pointerId); c.classList.add('dragging'); c.classList.remove('anim'); });
  c.addEventListener('pointermove', (e) => {
    if (x0 === null) return; dx = e.clientX - x0;
    c.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    c.querySelector('.stampyes').style.opacity = Math.min(1, Math.max(0, dx / 100));
    c.querySelector('.stampno').style.opacity = Math.min(1, Math.max(0, -dx / 100));
  });
  const end = () => {
    if (x0 === null) return; x0 = null; c.classList.remove('dragging');
    if (dx > 110) decide('apply'); else if (dx < -110) decide('skip'); else resetCard(c);
    dx = 0;
  };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
}
function resetCard(c) {
  c.classList.add('anim'); c.style.transform = ''; c.querySelector('.stampyes').style.opacity = 0; c.querySelector('.stampno').style.opacity = 0;
}
function renderDeck() {
  const d = $('deck'); d.replaceChildren();
  const [a, b] = state.deck;
  if (!a) {
    const p = state.me;
    const msg = !p ? '' : !p.verified ? 'Dein Profil wird noch geprüft. Sobald es freigeschaltet ist, erscheinen hier passende Schichten.'
      : p.accountStatus === 'SUSPENDED' ? 'Dein Konto ist vorübergehend gesperrt.' : 'Gerade keine passenden Schichten in deinem Umkreis.';
    d.append(el('div', { class: 'empty' }, el('div', {}, msg), p && p.verified ? el('button', { class: 'btn ghost', onclick: () => loadDeck().catch((e) => show(e.message)) }, 'Neu laden') : ''));
  } else { if (b) d.append(shiftCard(b, false)); d.append(shiftCard(a, true)); }
  $('deckButtons').hidden = !a; $('deckHint').hidden = !a;
}
async function loadDeck() {
  if (!state.me || !state.me.verified || state.me.accountStatus === 'SUSPENDED') { state.deck = []; return renderDeck(); }
  const q = new URLSearchParams({ radiusKm: $('radius').value, limit: '30' });
  if (state.pos) { q.set('lat', state.pos.lat); q.set('lon', state.pos.lon); }
  const skipped = new Set(json('jobs_skipped', []));
  state.deck = (await api('/marketplace/search?' + q)).shifts.filter((s) => !skipped.has(s.id));
  renderDeck();
}
async function decide(kind) {
  const s = state.deck[0]; if (!s || state.busy) return;
  state.busy = true; $('btnApply').disabled = $('btnSkip').disabled = true;
  const c = $('deck').querySelector('.swipe:not(.next)');
  try {
    if (kind === 'apply') { await api(`/marketplace/shifts/${s.id}/apply`, { method: 'POST' }); show('Bewerbung gesendet – der Betrieb meldet sich bei dir.', true); }
    else store.set('jobs_skipped', JSON.stringify([s.id, ...json('jobs_skipped', [])].slice(0, 200)));
    c.classList.remove('dragging'); c.classList.add('anim');
    c.style.transform = `translateX(${kind === 'apply' ? 600 : -600}px) rotate(${kind === 'apply' ? 25 : -25}deg)`; c.style.opacity = 0;
    await new Promise((r) => setTimeout(r, 260));
    state.deck.shift(); renderDeck();
    if (kind === 'apply') loadApps().catch(() => {});
  } catch (e) { show(e.message); resetCard(c); }
  finally { state.busy = false; $('btnApply').disabled = $('btnSkip').disabled = false; }
}
$('btnApply').onclick = () => decide('apply');
$('btnSkip').onclick = () => decide('skip');
$('radius').onchange = () => loadDeck().catch((e) => show(e.message));
$('useLocation').onclick = () => {
  if (state.pos) { state.pos = null; $('useLocation').textContent = 'Mein Standort'; return loadDeck().catch((e) => show(e.message)); }
  if (!navigator.geolocation) return show('Standort wird von diesem Gerät nicht unterstützt.');
  navigator.geolocation.getCurrentPosition((p) => {
    state.pos = { lat: p.coords.latitude, lon: p.coords.longitude }; $('useLocation').textContent = 'Wohnort nutzen';
    loadDeck().catch((e) => show(e.message));
  }, () => show('Standort nicht verfügbar – es wird dein Wohnort verwendet.'), { timeout: 8000 });
};

// ---- Bewerbungen ----
const APP_LABEL = { PENDING: 'Warten auf Antwort', ACCEPTED: 'Bestätigt', REJECTED: 'Nicht berücksichtigt' };
async function loadApps(quiet) {
  const list = await api('/freelancers/me/applications');
  const seen = new Set(json('jobs_seen', []));
  const fresh = list.filter((a) => a.status === 'ACCEPTED' && !seen.has(a.shift.id));
  state.apps = list;
  if (fresh.length) {
    if ($('tabApps').hidden) $('appBadge').hidden = false;
    if (quiet) show(`Gute Nachrichten: ${fresh[0].shift.restaurant.name} hat dich für ${fresh[0].shift.role} bestätigt!`, true);
  }
  if (!$('tabApps').hidden) { store.set('jobs_seen', JSON.stringify([...seen, ...fresh.map((a) => a.shift.id)].slice(-200))); $('appBadge').hidden = true; }
  renderApps();
}
function renderApps() {
  const box = $('apps'); box.replaceChildren();
  $('appsEmpty').hidden = state.apps.length > 0;
  for (const { status, shift: s } of state.apps) {
    const r = s.restaurant;
    const c = el('article', { class: 'app' },
      el('header', {}, el('div', {}, el('h3', {}, `${s.role} · ${euro(s.hourlyRateCents)}/Std.`),
        el('div', { class: 'meta' }, `${r.name} · ${r.city}`), el('div', { class: 'meta' }, `${fmtTime(s.startTime)} – ${new Date(s.endTime).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`)),
        el('span', { class: 'pill ' + status }, status === 'ACCEPTED' && s.status === 'COMPLETED' ? 'Abgeschlossen' : (APP_LABEL[status] || status))));
    if (status === 'ACCEPTED' && r.street) {
      c.append(el('div', { class: 'addr' }, `📍 ${r.street}, ${r.zip} ${r.city}`),
        el('p', { class: 'hint' }, 'Bitte pünktlich sein und vor Ort am Zeiterfassungsterminal einchecken.'),
        el('a', { class: 'btn ghost small', target: '_blank', rel: 'noopener', href: 'https://www.openstreetmap.org/search?query=' + encodeURIComponent(`${r.street}, ${r.zip} ${r.city}`) }, 'Route öffnen'));
    }
    if (status === 'PENDING') c.append(el('div', { class: 'actions' }, el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, async () => {
      await api(`/marketplace/shifts/${s.id}/withdraw`, { method: 'POST' }); await loadApps(); loadDeck().catch(() => {});
    }) }, 'Bewerbung zurückziehen')));
    box.append(c);
  }
}

// ---- Profil ----
function renderProfile() {
  const p = state.me; const box = $('profile'); box.replaceChildren(); if (!p) return;
  const kv = (k, v) => el('div', { class: 'kv' }, el('span', {}, k), el('span', {}, v));
  box.append(kv('Name', p.displayName),
    kv('Status', p.verified ? 'Verifiziert' : 'In Prüfung'),
    kv('Fähigkeiten', (p.verified ? p.verifiedSkills : p.claimedSkills).map((x) => SKILL[x] || x).join(', ') + (p.verified ? '' : ' (angegeben)')),
    kv('Bewertung', p.rating ? `★ ${p.rating} (${p.ratingCount})` : 'noch keine'),
    kv('Zuverlässigkeit', Math.round(p.reliabilityScore * 100) + ' %'),
    kv('Konto', p.accountStatus === 'SUSPENDED' ? 'Gesperrt bis ' + new Date(p.suspendedUntil).toLocaleDateString('de-DE') : 'Aktiv'));
}
function setBanner() {
  const p = state.me, b = $('banner'); b.className = 'banner'; b.hidden = false;
  if (p.accountStatus === 'SUSPENDED') { b.classList.add('err'); b.textContent = `Dein Konto ist bis ${new Date(p.suspendedUntil).toLocaleDateString('de-DE')} gesperrt, weil du zu einer bestätigten Schicht nicht erschienen bist.`; }
  else if (!p.verified) b.textContent = 'Willkommen! Wir prüfen gerade dein Profil. Sobald es freigeschaltet ist, kannst du Schichten annehmen.';
  else b.hidden = true;
}

// ---- Start ----
let poll;
async function start() {
  if (!store.get('jobs_token')) return view('landing');
  try { state.me = await api('/freelancers/me'); }
  catch (e) {
    logout(); show(/Freelancer-Profil/.test(e.message) ? 'Dieses Konto gehört zu einem Betrieb – bitte unter jobs.gastroevolution.de/app/ anmelden.' : e.message); return;
  }
  setBanner(); view('app'); renderProfile(); await Promise.all([loadDeck(), loadApps()]);
  clearInterval(poll);
  poll = setInterval(() => { if (document.visibilityState === 'visible' && store.get('jobs_token')) {
    api('/freelancers/me').then((m) => { const was = state.me && state.me.verified; state.me = m; setBanner(); if (m.verified && !was) loadDeck(); }).catch(() => {});
    loadApps(true).catch(() => {}); } }, 30000);
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: '/jobs/' }).catch(() => {});
start().catch((e) => { logout(); show(e.message); });
