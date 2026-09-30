'use strict';
// Schlichte Wirte-Oberfläche. Alle Ausgaben via textContent (kein innerHTML) → kein XSS.
const API = '/api/v1';
const $ = (id) => document.getElementById(id);
const store = {
  get: () => { try { return sessionStorage.getItem('ss_token'); } catch { return null; } },
  set: (t) => { try { t ? sessionStorage.setItem('ss_token', t) : sessionStorage.removeItem('ss_token'); } catch { /* ignorieren */ } },
};

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
function errorText(body) {
  if (body && body.issues) return body.issues.map((i) => i.message).join(' · ');
  return (body && body.message) || 'Unbekannter Fehler';
}
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(store.get() ? { authorization: 'Bearer ' + store.get() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* leere Antwort */ }
  if (res.status === 401 && store.get()) { logout(); throw new Error('Sitzung abgelaufen – bitte erneut anmelden'); }
  if (res.status === 429) throw new Error('Zu viele Anfragen – bitte kurz warten');
  if (!res.ok) throw new Error(errorText(data));
  return data;
}
async function busy(btn, fn) {
  btn.disabled = true; show('');
  try { await fn(); } catch (e) { show(e.message); } finally { btn.disabled = false; }
}

// ---- Anmeldung ----
function view(name) {
  $('landing').hidden = name !== 'landing'; $('auth').hidden = name !== 'auth'; $('dash').hidden = name !== 'dash';
  const guest = name !== 'dash';
  $('guestbox').hidden = !guest; $('userbox').hidden = guest; $('nav').hidden = !guest;
  window.scrollTo({ top: 0 });
}
function logout() { store.set(null); view('landing'); }
function tab(login) {
  $('loginForm').hidden = !login; $('registerForm').hidden = login;
  $('tabLogin').classList.toggle('active', login); $('tabRegister').classList.toggle('active', !login); show('');
}
const formData = (form) => Object.fromEntries(new FormData(form));

function openAuth(login) { view('auth'); tab(login); }
$('goLogin').onclick = () => openAuth(true);
$('goRegister').onclick = () => openAuth(false);
$('ctaRegister').onclick = () => openAuth(false);
$('home').addEventListener('click', (e) => { e.preventDefault(); if (!store.get()) view('landing'); });
$('tabLogin').onclick = () => tab(true);
$('tabRegister').onclick = () => tab(false);
$('logout').onclick = logout;
$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => { store.set((await api('/auth/login', { method: 'POST', body: formData(e.target) })).token); await start(); });
});
$('registerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => { store.set((await api('/auth/register', { method: 'POST', body: formData(e.target) })).token); await start(); });
});

// ---- Schichten ----
const fmt = (iso) => new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const euro = (c) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const FIELDS = { taetigkeitsschluessel: 'Tätigkeitsschlüssel', betriebsnummerArbeitgeber: 'Betriebsnummer' };
const STATUS = { OPEN: 'Offen', MATCHED: 'Besetzt', COMPLETED: 'Abgeschlossen', CANCELLED: 'Zurückgezogen' };

$('shiftForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = formData(e.target);
  const skill = { Barkeeper: 'BAR', Service: 'SERVICE', Servicekraft: 'SERVICE', Koch: 'KITCHEN', Küchenhilfe: 'KITCHEN', Spüler: 'DISHWASHING' }[f.role];
  busy(e.submitter, async () => {
    await api('/marketplace/shifts', { method: 'POST', body: {
      restaurantId: state.restaurantId, role: f.role, requiredSkill: skill,
      hourlyRateCents: Math.round(parseFloat(f.rate) * 100),
      startTime: new Date(f.start).toISOString(), endTime: new Date(f.end).toISOString(),
      ...(f.requirements.trim() ? { requirements: f.requirements.trim() } : {}),
      ...(f.activityKey.trim() ? { activityKey: f.activityKey.trim() } : {}),
    } });
    e.target.reset(); e.target.elements.rate.value = '19';
    show('Schicht veröffentlicht – passende Aushilfen im Umkreis sehen sie jetzt.', true);
    await loadShifts();
  });
});

async function renderApplicants(box, shift) {
  const list = await api(`/marketplace/shifts/${shift.id}/applications`);
  box.replaceChildren();
  for (const a of list) {
    const stars = a.rating ? `★ ${a.rating} (${a.ratingCount})` : 'noch keine Bewertung';
    box.append(el('div', { class: 'applicant' },
      el('div', {}, el('strong', {}, a.displayName), el('div', { class: 'meta' }, `${stars} · ${a.verifiedSkills.join(', ')}`)),
      el('button', { class: 'btn accent', onclick: (ev) => busy(ev.target, async () => {
        await api(`/marketplace/shifts/${shift.id}/accept`, { method: 'POST', body: { freelancerId: a.id } });
        show(`${a.displayName} ist bestätigt und im Dienstplan eingetragen.`, true); await loadShifts();
      }) }, 'Bestätigen')));
  }
}

function card(s) {
  const c = el('article', { class: 'shift' },
    el('header', {},
      el('div', {}, el('h3', {}, `${s.role} · ${euro(s.hourlyRateCents)}/Std.`),
        el('div', { class: 'meta' }, `${fmt(s.startTime)} – ${fmt(s.endTime)}${s.requirements ? ' · ' + s.requirements : ''}`)),
      el('span', { class: 'pill ' + s.status }, STATUS[s.status] || s.status)));
  if (s.status === 'OPEN') {
    const box = el('div', { class: 'applicants' });
    box.append(el('span', { class: 'meta' }, s.pendingApplications ? 'Bewerber werden geladen …' : 'Noch keine Bewerbungen – Aushilfen im Umkreis sind benachrichtigt.'));
    if (s.pendingApplications) renderApplicants(box, s).catch((e) => show(e.message));
    c.append(box, el('div', { class: 'actions' }, el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, async () => {
      if (!confirm('Schicht wirklich zurückziehen?')) return;
      await api(`/marketplace/shifts/${s.id}/cancel`, { method: 'POST' }); await loadShifts();
    }) }, 'Zurückziehen')));
  }
  if (s.status === 'MATCHED' && s.sofortmeldung) {
    const ok = s.sofortmeldung.status === 'READY';
    c.append(el('div', { class: 'actions' },
      el('span', { class: 'meta' }, ok ? 'Sofortmeldung: Daten bereit' : 'Sofortmeldung: bitte ergänzen – ' + s.sofortmeldung.missingFields.map((x) => FIELDS[x] || x).join(', ')),
      ok ? el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, async () => {
        const data = await api(`/marketplace/shifts/${s.id}/sofortmeldung-export`);
        const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' })), download: `sofortmeldung-${s.id}.json` });
        a.click(); URL.revokeObjectURL(a.href);
      }) }, 'Meldedaten exportieren') : ''));
  }
  return c;
}

async function loadShifts() {
  const shifts = await api('/marketplace/my-shifts');
  $('shifts').replaceChildren(...shifts.map(card));
  $('empty').hidden = shifts.length > 0;
}

// ---- Start ----
const state = { restaurantId: null };
async function start() {
  if (!store.get()) return view('landing');
  const me = await api('/auth/me');
  const r = me.restaurants.find((x) => x.role === 'OWNER');
  if (!r) { logout(); show('Für dieses Konto ist kein Betrieb hinterlegt.'); return; }
  state.restaurantId = r.id;
  $('restaurantName').textContent = `${r.name} · ${me.email}`;
  view('dash');
  await loadShifts();
}
start().catch((e) => { logout(); show(e.message); });
