'use strict';
// Schlichte Wirte-Oberfläche. Alle Ausgaben via textContent (kein innerHTML) → kein XSS.
const API = '/api/v1';
const $ = (id) => document.getElementById(id);
const store = {
  getInvite: () => { try { return sessionStorage.getItem('ss_invite'); } catch { return null; } },
  setInvite: (t) => { try { t ? sessionStorage.setItem('ss_invite', t) : sessionStorage.removeItem('ss_invite'); } catch { /* ignorieren */ } },
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
  if (res.status === 401 && store.get() && data && data.error === 'UNAUTHORIZED') { logout(); throw new Error('Sitzung abgelaufen – bitte erneut anmelden'); }
  if (res.status === 429) throw new Error('Zu viele Anfragen – bitte kurz warten');
  if (!res.ok) { const err = new Error(errorText(data)); err.body = data; throw err; }
  return data;
}
async function busy(btn, fn) {
  btn.disabled = true; show('');
  try { await fn(); } catch (e) { if (e.message !== 'Abgebrochen') show(e.message); } finally { btn.disabled = false; }
}

// ---- Anmeldung ----
function view(name) {
  $('landing').hidden = name !== 'landing'; $('auth').hidden = name !== 'auth'; $('verify').hidden = name !== 'verify'; $('dash').hidden = name !== 'dash'; $('adminview').hidden = name !== 'admin';
  const guest = name !== 'dash' && name !== 'admin';
  $('guestbox').hidden = !guest; $('userbox').hidden = guest; $('nav').hidden = !guest;
  $('adminBtn').hidden = guest || name === 'admin' || !state.isAdmin; $('backBtn').hidden = name !== 'admin' || !state.restaurantId;
  window.scrollTo({ top: 0 });
}
function logout() { store.set(null); view('landing'); }
function tab(login) {
  $('loginForm').hidden = !login; $('registerForm').hidden = login;
  $('tabLogin').classList.toggle('active', login); $('tabRegister').classList.toggle('active', !login); show('');
}
const formData = (form) => Object.fromEntries(new FormData(form));

function openAuth(login) { view('auth'); tab(login); applyInviteMode(!!state.invite); }
$('goLogin').onclick = () => openAuth(true);
$('goRegister').onclick = () => openAuth(false);
$('ctaRegister').onclick = () => openAuth(false);
$('home').addEventListener('click', (e) => { e.preventDefault(); if (!store.get()) view('landing'); });
$('tabLogin').onclick = () => tab(true);
$('tabRegister').onclick = () => tab(false);
$('logout').onclick = logout;
$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault(); const f = formData(e.target);
  busy(e.submitter, async () => {
    try {
      const r = await api('/auth/login', { method: 'POST', body: f });
      openVerify('login', r.challengeToken, r.twoFactor);
    } catch (err) {
      if (err.body && err.body.error === 'NOT_VERIFIED') { openVerify('signup', err.body.verificationToken); show('Bitte bestätige zuerst deine E-Mail-Adresse – wir haben dir einen neuen Code geschickt.', true); return; }
      throw err;
    }
  });
});
$('registerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const fd = new FormData(e.target);
    const r = state.invite
      ? await api('/auth/register-invited', { method: 'POST', body: { token: state.invite.token, phone: fd.get('phone'), password: fd.get('password'), acceptTerms: fd.has('acceptTerms') } })
      : await api('/auth/register', { method: 'POST', body: { ...Object.fromEntries(fd), acceptTerms: fd.has('acceptTerms') } });
    if (state.invite) { store.setInvite(null); state.invite = null; }
    openVerify('signup', r.verificationToken);
  });
});
async function onSession(token) { store.set(token); await start(); }

// ---- Einladung in einen Betrieb (Link ?invite=…) ----
function applyInviteMode(on) {
  const box = $('restaurantFields'); box.hidden = on;
  box.querySelectorAll('input').forEach((i) => { i.disabled = on; });
  const em = $('registerForm').elements.email; em.readOnly = on; if (on) em.value = state.invite.email;
  $('registerHint').textContent = on ? `Einladung von „${state.invite.restaurantName}“: Legen Sie Ihr Konto an, um den Betrieb mitzuverwalten.` : 'Schichten in Ihrem Umkreis (max. 25 km) an verifizierte Aushilfen ausschreiben.';
}
async function loadInvite() {
  const t = new URLSearchParams(location.search).get('invite') || store.getInvite();
  if (!t) return;
  history.replaceState(null, '', location.pathname);
  try {
    const info = await api('/auth/invitation/' + encodeURIComponent(t));
    state.invite = { token: t, ...info }; store.setInvite(t);
  } catch { store.setInvite(null); show('Diese Einladung ist ungültig oder abgelaufen.'); }
}
async function acceptPendingInvite() {
  if (!state.invite || !store.get()) return false;
  try { await api('/auth/invitation/accept', { method: 'POST', body: { token: state.invite.token } }); show(`Willkommen im Team von „${state.invite.restaurantName}“!`, true); }
  catch (e) { show(e.message); }
  store.setInvite(null); state.invite = null; return true;
}

// ---- Bestätigungscodes (Registrierung) bzw. zweiter Faktor (Anmeldung) ----
const pending = { mode: null, token: null };
function setVerifyRows(emailRow, loginRow, passRow = false) {
  const f = $('verifyForm').elements;
  $('emailCodeRow').hidden = !emailRow; $('loginCodeRow').hidden = !loginRow; $('newPasswordRow').hidden = !passRow;
  f.emailCode.required = emailRow; f.code.required = loginRow; f.newPassword.required = passRow;
}
function openVerify(mode, token, factor) {
  pending.mode = mode; pending.token = token; view('verify'); show('');
  const signup = mode === 'signup', reset = mode === 'reset';
  $('verifyForm').reset(); setVerifyRows(signup, !signup, reset);
  $('verifyTitle').textContent = reset ? 'Passwort zurücksetzen' : signup ? 'E-Mail bestätigen' : 'Sicherheitscode';
  $('verifyText').textContent = reset ? 'Falls zu dieser E-Mail-Adresse ein Konto existiert, haben wir dir einen Code geschickt. Gib ihn ein und wähle ein neues Passwort.'
    : signup ? 'Wir haben dir einen Code per E-Mail geschickt. Bitte gib ihn hier ein.'
    : factor === 'totp' ? 'Gib den 6-stelligen Code aus deiner Authenticator-App ein.' : 'Zur Sicherheit haben wir dir einen Code per E-Mail geschickt.';
  $('resendMail').textContent = !reset && !signup && factor === 'totp' ? 'Stattdessen Code per E-Mail senden' : 'Code erneut senden';
}
$('verifyForm').addEventListener('submit', (e) => {
  e.preventDefault(); const f = formData(e.target);
  busy(e.submitter, async () => {
    if (pending.mode === 'reset') {
      await api('/auth/password/reset', { method: 'POST', body: { email: pending.token, code: f.code, newPassword: f.newPassword } });
      openAuth(true); show('Passwort geändert – bitte melde dich jetzt an.', true); return;
    }
    const r = pending.mode === 'signup'
      ? await api('/auth/verify', { method: 'POST', body: { verificationToken: pending.token, emailCode: f.emailCode } })
      : await api('/auth/login/verify', { method: 'POST', body: { challengeToken: pending.token, code: f.code } });
    await onSession(r.token);
  });
});
const resend = async () => {
  if (pending.mode === 'reset') await api('/auth/password/forgot', { method: 'POST', body: { email: pending.token } });
  else await api('/auth/resend', { method: 'POST', body: { token: pending.token, purpose: pending.mode } });
  show('Neuer Code wurde per E-Mail gesendet.', true);
};
$('resendMail').onclick = (e) => busy(e.target, resend);
$('forgotLink').onclick = (e) => busy(e.target, async () => {
  const email = $('loginForm').elements.email.value.trim();
  if (!email) throw new Error('Bitte trage oben deine E-Mail-Adresse ein.');
  await api('/auth/password/forgot', { method: 'POST', body: { email } }); openVerify('reset', email);
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
      hourlyRateCents: Math.round(parseFloat(f.rate) * 100), positions: parseInt(f.positions, 10) || 1,
      startTime: new Date(f.start).toISOString(), endTime: new Date(f.end).toISOString(),
      ...(f.requirements.trim() ? { requirements: f.requirements.trim() } : {}),
      ...(f.activityKey.trim() ? { activityKey: f.activityKey.trim() } : {}),
    } });
    e.target.reset(); e.target.elements.rate.value = '19'; e.target.elements.positions.value = '1';
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
      el('div', {}, el('strong', {}, a.displayName), el('div', { class: 'meta' }, `${stars} · ${a.verifiedSkills.join(', ')}`),
        el('div', { class: 'meta' }, a.hygieneIssuedOn ? `Hygiene-Belehrung ✓ ausgestellt am ${new Date(a.hygieneIssuedOn).toLocaleDateString('de-DE')}` : 'Kein Hygienenachweis')),
      el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, async () => {
        if (!confirm(`Bewerbung von ${a.displayName} ablehnen? Die Aushilfe wird informiert.`)) throw new Error('Abgebrochen');
        await api(`/marketplace/shifts/${shift.id}/reject`, { method: 'POST', body: { freelancerId: a.id } }); await loadShifts();
      }) }, 'Ablehnen'),
      el('button', { class: 'btn accent', onclick: (ev) => busy(ev.target, async () => {
        await api(`/marketplace/shifts/${shift.id}/accept`, { method: 'POST', body: { freelancerId: a.id } });
        show(`${a.displayName} ist bestätigt und im Dienstplan eingetragen.`, true); await loadShifts();
      }) }, 'Bestätigen')));
  }
}

// Hygienenachweis der zugesagten Aushilfe (Nachweispflicht des Arbeitgebers) in neuem Tab öffnen
async function openCertificate(shiftId) {
  const w = window.open('', '_blank'); // vor dem await öffnen, sonst blockt der Browser das Pop-up
  try {
    const res = await fetch(`${API}/marketplace/shifts/${shiftId}/hygiene-certificate`, { headers: { authorization: 'Bearer ' + store.get() } });
    if (!res.ok) throw new Error(errorText(await res.json().catch(() => null)));
    if (w) w.location = URL.createObjectURL(await res.blob());
  } catch (e) { if (w) w.close(); throw e; }
}

// Sofortmeldung: Ablauf für den Betrieb (Daten ergänzen → exportieren → melden → abhaken)
function sofortmeldungControls(s) {
  const n = s.sofortmeldung, reported = n.status === 'SENT', soon = !reported && new Date(s.startTime).getTime() - Date.now() < 3 * 3600e3;
  const box = el('div', { class: 'sm' + (soon ? ' warn' : '') }, el('strong', {}, 'Sofortmeldung'));
  const run = (label, fn, cls = 'secondary') => el('button', { class: cls, onclick: (ev) => busy(ev.target, async () => { await fn(); await loadShifts(); }) }, label);
  if (reported) { box.append(el('div', { class: 'meta' }, `✓ gemeldet am ${new Date(n.reportedAt).toLocaleString('de-DE')}${n.reference ? ' · Ref. ' + n.reference : ''}`)); return box; }
  box.append(el('div', { class: 'meta' }, soon ? 'Bald ist Schichtbeginn – bitte jetzt melden! Die Meldung muss spätestens bei Arbeitsbeginn erfolgen.' : 'Bitte spätestens bei Arbeitsbeginn bei der Sozialversicherung melden und danach hier abhaken.'));
  if (n.status === 'NEEDS_DATA') {
    const inp = el('input', { inputmode: 'numeric', maxlength: '9', pattern: '\\d{9}', placeholder: 'Tätigkeitsschlüssel (9 Ziffern)', 'aria-label': 'Tätigkeitsschlüssel' });
    box.append(el('div', { class: 'meta' }, 'Es fehlt: ' + n.missingFields.map((x) => FIELDS[x] || x).join(', ')),
      el('div', { class: 'row-gap' }, inp, run('Speichern', () => api(`/marketplace/shifts/${s.id}/activity-key`, { method: 'PUT', body: { activityKey: inp.value.trim() } }))));
    return box;
  }
  box.append(el('div', { class: 'actions' },
    el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, async () => {
      const data = await api(`/marketplace/shifts/${s.id}/sofortmeldung-export`);
      const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' })), download: `sofortmeldung-${s.id}.json` });
      a.click(); URL.revokeObjectURL(a.href);
    }) }, 'Meldedaten exportieren'),
    run('Als gemeldet markieren', async () => {
      const ref = prompt('Optional: Referenz-/Bestätigungsnummer der Meldung (leer lassen, wenn keine)', '');
      if (ref === null) throw new Error('Abgebrochen');
      await api(`/marketplace/shifts/${s.id}/sofortmeldung/reported`, { method: 'POST', body: ref.trim() ? { reference: ref.trim() } : {} });
    }, 'btn accent')));
  return box;
}

// Anwesenheit und Bewertung nach der Schicht
function matchedControls(s) {
  const a = s.assignment, now = Date.now(), start = new Date(s.startTime).getTime(), end = new Date(s.endTime).getTime();
  const box = el('div', { class: 'applicants' }, el('div', { class: 'meta' }, `Aushilfe: ${a.freelancer.displayName}`),
    el('div', { class: 'actions' }, el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, () => openCertificate(s.id)) }, 'Hygienenachweis ansehen')));
  const act = (label, fn, cls = 'secondary') => el('button', { class: cls, onclick: (ev) => busy(ev.target, async () => { await fn(); await loadShifts(); }) }, label);
  if (!a.noShowRecordedAt && !a.clockedInAt && now < start) {
    const warn = s.sofortmeldung && s.sofortmeldung.status === 'SENT' ? '\n\nHinweis: Die Sofortmeldung ist schon als gemeldet markiert – bitte stornieren Sie diese bei der Sozialversicherung.' : '';
    const cancel = (reopen, text) => async () => {
      if (!confirm(text + warn)) throw new Error('Abgebrochen');
      await api(`/marketplace/shifts/${s.id}/cancel-match`, { method: 'POST', body: { reopen } }); show(reopen ? 'Zusage zurückgenommen – die Schicht ist wieder ausgeschrieben.' : 'Schicht abgesagt.', true);
    };
    box.append(el('div', { class: 'actions' }, act('Aushilfe austauschen', cancel(true, 'Zusage zurücknehmen und die Schicht neu ausschreiben? Die Aushilfe wird informiert.')),
      act('Schicht absagen', cancel(false, 'Zusage zurücknehmen und die Schicht ganz absagen? Die Aushilfe wird informiert.'), 'secondary danger')));
  }
  if (a.noShowRecordedAt) box.append(el('div', { class: 'meta' }, 'Nicht erschienen – die Aushilfe wurde gesperrt.'));
  else if (!a.clockedInAt) {
    const row = el('div', { class: 'actions' });
    if (now >= start - 30 * 60000) row.append(act('Ist erschienen', () => api(`/marketplace/shifts/${s.id}/attendance`, { method: 'POST', body: { status: 'PRESENT' } }), 'btn accent'));
    else row.append(el('span', { class: 'meta' }, 'Anwesenheit bestätigen ab ' + new Date(start - 30 * 60000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'));
    if (now >= start + 15 * 60000) row.append(act('Nicht erschienen', async () => {
      if (!confirm('Nichterscheinen melden? Die Aushilfe wird dadurch gesperrt.')) throw new Error('Abgebrochen');
      await api(`/marketplace/shifts/${s.id}/attendance`, { method: 'POST', body: { status: 'NO_SHOW' } });
    }));
    box.append(row);
  } else if (now < end) box.append(el('div', { class: 'meta' }, 'Eingecheckt ✓ – nach Schichtende kannst du die Aushilfe bewerten.'));
  else {
    const row = el('div', { class: 'actions' }, el('span', { class: 'meta' }, 'Schicht abschließen und bewerten:'));
    for (let n = 1; n <= 5; n++) row.append(act('★'.repeat(n), () => api(`/marketplace/shifts/${s.id}/complete`, { method: 'POST', body: { rating: n } })));
    box.append(row);
  }
  return box;
}

// Schicht als Vorlage: Formular mit den Angaben füllen, Termin eine Woche später (gleiche Uhrzeit)
function useAsTemplate(s) {
  const f = $('shiftForm').elements, local = (iso) => { const d = new Date(new Date(iso).getTime() + 7 * 864e5); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  f.role.value = s.role; f.rate.value = (s.hourlyRateCents / 100).toFixed(2); f.positions.value = String(s.slotCount || 1);
  f.start.value = local(s.startTime); f.end.value = local(s.endTime); f.requirements.value = s.requirements || ''; f.activityKey.value = s.activityKey || '';
  $('shiftForm').scrollIntoView({ behavior: 'smooth', block: 'center' }); show('Vorlage übernommen – bitte Datum und Uhrzeit prüfen und veröffentlichen.', true);
}

function card(s) {
  const c = el('article', { class: 'shift' },
    el('header', {},
      el('div', {}, el('h3', {}, `${s.role} · ${euro(s.hourlyRateCents)}/Std.${s.slotCount > 1 ? ` · Stelle ${s.slotIndex} von ${s.slotCount}` : ''}`),
        el('div', { class: 'meta' }, `${fmt(s.startTime)} – ${fmt(s.endTime)}${s.requirements ? ' · ' + s.requirements : ''}`)),
      el('span', { class: 'pill ' + s.status }, STATUS[s.status] || s.status)));
  if (s.status === 'OPEN') {
    const box = el('div', { class: 'applicants' });
    box.append(el('span', { class: 'meta' }, s.pendingApplications ? 'Bewerber werden geladen …' : 'Noch keine Bewerbungen – Aushilfen im Umkreis sind benachrichtigt.'));
    if (s.pendingApplications) renderApplicants(box, s).catch((e) => show(e.message));
    c.append(box, state.role !== 'OWNER' ? '' : el('div', { class: 'actions' }, el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, async () => {
      if (!confirm('Schicht wirklich zurückziehen?')) return;
      await api(`/marketplace/shifts/${s.id}/cancel`, { method: 'POST' }); await loadShifts();
    }) }, 'Zurückziehen')));
  }
  if (s.status === 'MATCHED' && s.assignment) c.append(matchedControls(s));
  if (state.role === 'OWNER') c.append(el('div', { class: 'actions' }, el('button', { class: 'link', type: 'button', onclick: () => useAsTemplate(s) }, 'Als Vorlage für eine neue Schicht')));
  if (s.status === 'COMPLETED' && s.rating) c.append(el('div', { class: 'meta' }, `Abgeschlossen · Bewertung ${'★'.repeat(s.rating)}${'☆'.repeat(5 - s.rating)}`));
  if ((s.status === 'MATCHED' || s.status === 'COMPLETED') && s.sofortmeldung) c.append(sofortmeldungControls(s));
  return c;
}

async function loadShifts() {
  const shifts = await api('/marketplace/my-shifts');
  $('shifts').replaceChildren(...shifts.map(card));
  $('empty').hidden = shifts.length > 0;
}

// ---- Start ----
const state = { restaurantId: null, isAdmin: false, role: 'OWNER', invite: null };
async function start() {
  if (!store.get()) { if (state.invite) return openAuth(false); return view('landing'); }
  await acceptPendingInvite();
  const me = await api('/auth/me');
  state.isAdmin = !!me.isAdmin;
  const r = me.restaurants.find((x) => x.role === 'OWNER') || me.restaurants.find((x) => x.role === 'MANAGER');
  if (!r && !me.isAdmin) { logout(); show('Für dieses Konto ist kein Betrieb hinterlegt.'); return; }
  state.restaurantId = r ? r.id : null; state.role = r ? r.role : 'OWNER';
  $('restaurantName').textContent = r ? `${r.name} · ${me.email}` : me.email;
  $('myRating').textContent = r && r.rating ? `Bewertung durch Aushilfen: ★ ${r.rating.toLocaleString('de-DE')} (${r.ratingCount})` : 'Noch keine Bewertungen durch Aushilfen.';
  if (!r) return openAdmin().catch((e) => show(e.message));
  view('dash');
  const owner = state.role === 'OWNER';
  // Manager verwalten Bewerber, Anwesenheit und Bewertungen; Ausschreiben, Team und Schnittstelle bleiben dem Inhaber vorbehalten
  $('shiftForm').closest('.card').hidden = !owner; $('integrations').hidden = !owner; $('team').hidden = !owner;
  TotpUI.mount($('security'), { api, show, enabled: me.totpEnabled, onChange: () => start() });
  PushUI.mount($('push'), { api, show, swScope: '/app/' });
  renderAccount();
  if (owner) { renderIntegrations(); renderTeam(); }
  await loadShifts();
}

// ---- Konto: Datenauskunft und Löschen ----
function renderAccount() {
  const box = $('account'), pw = () => el('input', { type: 'password', autocomplete: 'current-password', required: '', placeholder: 'Passwort zur Bestätigung' });
  const p1 = pw(), p2 = pw();
  const f1 = el('form', { class: 'form', hidden: '' }, p1, el('button', { class: 'btn ghost' }, 'Datei herunterladen'));
  f1.addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const data = await api('/auth/me/export', { method: 'POST', body: { password: p1.value } });
    const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'meine-daten.json' }); a.click(); URL.revokeObjectURL(a.href);
    f1.reset(); f1.hidden = true; show('Ihre Daten wurden heruntergeladen (meine-daten.json).', true);
  }); });
  const f2 = el('form', { class: 'form', hidden: '' }, p2, el('button', { class: 'btn ghost danger' }, 'Konto endgültig löschen'));
  f2.addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => {
    if (!confirm('Konto wirklich endgültig löschen? Offene Schichten werden zurückgezogen, der Betrieb wird gesperrt. Das kann nicht rückgängig gemacht werden.')) throw new Error('Abgebrochen');
    await api('/auth/me', { method: 'DELETE', body: { password: p2.value } }); logout(); show('Ihr Konto wurde gelöscht.', true);
  }); });
  box.replaceChildren(el('h2', {}, 'Konto und Daten'),
    el('p', { class: 'hint' }, 'Auf Wunsch erhalten Sie alle zu Ihrem Konto gespeicherten Daten als Datei. Daten der vermittelten Aushilfen (z. B. SV-Nummern) sind als Daten Dritter nicht enthalten.'),
    el('button', { class: 'link', type: 'button', onclick: () => { f1.hidden = !f1.hidden; } }, 'Meine Daten herunterladen …'), f1,
    el('p', { class: 'hint' }, 'Sie können Ihr Konto löschen, solange keine bestätigte Schicht aussteht. Gesetzlich aufbewahrungspflichtige Melde- und Einsatzdaten bleiben erhalten.'),
    el('button', { class: 'link danger', type: 'button', onclick: () => { f2.hidden = !f2.hidden; } }, 'Konto löschen …'), f2);
}

// ---- Team: Manager einladen (nur Inhaber) ----
async function renderTeam() {
  const box = $('team'), base = `/restaurants/${state.restaurantId}/team`;
  const t = await api(base);
  box.replaceChildren(el('h2', {}, 'Team'), el('p', { class: 'hint' }, 'Manager können Bewerber bestätigen, die Anwesenheit melden und bewerten. Schichten ausschreiben und Einstellungen bleiben beim Inhaber.'));
  for (const m of t.members) box.append(el('div', { class: 'applicant' }, el('div', {}, el('strong', {}, m.email), el('div', { class: 'meta' }, m.role === 'OWNER' ? 'Inhaber' : 'Manager')),
    m.role === 'MANAGER' ? el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, async () => { if (!confirm(`${m.email} aus dem Team entfernen?`)) throw new Error('Abgebrochen'); await api(`${base}/members/${m.userId}`, { method: 'DELETE' }); await renderTeam(); }) }, 'Entfernen') : ''));
  for (const i of t.invitations) box.append(el('div', { class: 'applicant' }, el('div', {}, el('strong', {}, i.email), el('div', { class: 'meta' }, `eingeladen · gültig bis ${new Date(i.expiresAt).toLocaleDateString('de-DE')}`)),
    el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, async () => { await api(`${base}/invitations/${i.id}`, { method: 'DELETE' }); await renderTeam(); }) }, 'Widerrufen')));
  const form = el('form', { class: 'row-gap' }, el('input', { name: 'email', type: 'email', placeholder: 'E-Mail-Adresse der Person', required: '' }), el('button', { class: 'btn ghost' }, 'Als Manager einladen'));
  form.addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => { await api(`${base}/invitations`, { method: 'POST', body: { email: form.elements.email.value } }); show('Einladung per E-Mail verschickt.', true); await renderTeam(); }); });
  box.append(form);
}

// ---- API-Schlüssel für Zeiterfassungsterminal / Dienstplan-System ----
async function renderIntegrations(newKey) {
  const box = $('integrations'); if (!state.restaurantId) return;
  const base = `/restaurants/${state.restaurantId}/api-keys`;
  const keys = await api(base);
  box.replaceChildren(el('h2', {}, 'Zeiterfassungsterminal'),
    el('p', { class: 'hint' }, 'Ohne Terminal bestätigen Sie die Anwesenheit selbst (Schaltfläche „Ist erschienen“). Mit einem API-Schlüssel kann Ihr Terminal das Einchecken automatisch melden – dann werden Aushilfen, die nicht einchecken, automatisch als „nicht erschienen“ gewertet.'));
  const form = el('form', { class: 'row-gap' }, el('input', { name: 'name', placeholder: 'Bezeichnung, z. B. Terminal Küche', required: '', minlength: '2', maxlength: '60' }), el('button', { class: 'btn ghost' }, 'Schlüssel erzeugen'));
  form.addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const r = await api(base, { method: 'POST', body: { name: form.elements.name.value } });
    await renderIntegrations(r.key); // Liste neu laden; der Schlüssel wird nur in dieser einen Ansicht gezeigt
  }); });
  box.append(form);
  if (newKey) box.append(el('div', { class: 'keybox' }, el('strong', {}, 'Ihr API-Schlüssel – wird nur jetzt angezeigt, bitte sicher speichern:'), el('div', {}, el('code', {}, newKey))));
  for (const k of keys) box.append(el('div', { class: 'applicant' },
    el('div', {}, el('strong', {}, k.name), el('div', { class: 'meta' }, `${k.prefix}… · erstellt ${new Date(k.createdAt).toLocaleDateString('de-DE')}${k.lastUsedAt ? ' · zuletzt genutzt ' + fmt(k.lastUsedAt) : ' · noch nicht genutzt'}${k.revokedAt ? ' · widerrufen' : ''}`)),
    k.revokedAt ? '' : el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, async () => { if (!confirm('Schlüssel widerrufen? Das Terminal verliert sofort den Zugriff.')) return; await api(`${base}/${k.id}`, { method: 'DELETE' }); await renderIntegrations(); }) }, 'Widerrufen')));
  box.append(el('details', { class: 'doc' }, el('summary', {}, 'Anleitung für die Anbindung'), el('pre', {},
`# Bestätigte Schichten abrufen (Dienstplan-Abgleich)
curl -H "Authorization: Bearer ge_…" https://jobs.gastroevolution.de/api/v1/integrations/shifts

# Einchecken der zugesagten Aushilfe melden
curl -X POST -H "Authorization: Bearer ge_…" -H "Content-Type: application/json" \
  -d '{"shiftId":"<Schicht-ID>"}' https://jobs.gastroevolution.de/api/v1/integrations/clock-in`)));
}

// ---- Verwaltung (nur Administratoren) ----
$('adminBtn').onclick = () => openAdmin().catch(async (e) => { if (state.restaurantId) await start(); show(e.message); }); // bei Ablehnung zurück zu „Meine Schichten“, Meldung bleibt sichtbar
$('backBtn').onclick = () => start().catch((e) => show(e.message));
let adminTab = 'overview';
function openAdmin() { view('admin'); return loadAdmin('overview'); }
document.querySelectorAll('#adminview [data-admin]').forEach((b) => b.addEventListener('click', () => loadAdmin(b.dataset.admin).catch((e) => show(e.message))));
$('adminSearch').addEventListener('input', () => { clearTimeout($('adminSearch')._t); $('adminSearch')._t = setTimeout(() => loadAdmin(adminTab).catch((e) => show(e.message)), 350); });

async function openBlob(path) {
  const w = window.open('', '_blank');
  try {
    const res = await fetch(API + path, { headers: { authorization: 'Bearer ' + store.get() } });
    if (!res.ok) throw new Error(errorText(await res.json().catch(() => null)));
    if (w) w.location = URL.createObjectURL(await res.blob());
  } catch (e) { if (w) w.close(); throw e; }
}
async function loadAdmin(tabName) {
  adminTab = tabName; show('');
  document.querySelectorAll('#adminview [data-admin]').forEach((b) => b.classList.toggle('active', b.dataset.admin === tabName));
  $('adminSearchRow').hidden = !['freelancers', 'restaurants'].includes(tabName);
  const body = $('adminBody'), q = encodeURIComponent($('adminSearch').value.trim());
  const act = (label, fn, cls = 'secondary') => el('button', { class: cls, onclick: (ev) => busy(ev.target, async () => { await fn(); await loadAdmin(tabName); }) }, label);
  const post = (path, b) => api('/admin' + path, { method: 'POST', body: b });
  body.replaceChildren();
  if (tabName === 'overview') {
    const s = await api('/admin/stats');
    const stat = (n, l) => el('div', { class: 'stat' }, el('b', {}, String(n)), el('span', {}, l));
    body.append(el('div', { class: 'grid-stats' }, stat(s.freelancers, 'Aushilfen'), stat(s.verified, 'davon freigeschaltet'), stat(s.suspended, 'gesperrt'), stat(s.restaurants, 'Betriebe'), stat(s.blocked, 'Betriebe gesperrt'),
      stat(s.shifts.open, 'Schichten offen'), stat(s.shifts.matched, 'Schichten besetzt'), stat(s.shifts.completed, 'Schichten abgeschlossen')));
  } else if (tabName === 'freelancers') {
    const list = await api('/admin/freelancers?q=' + q);
    if (!list.length) body.append(el('p', { class: 'hint' }, 'Keine Treffer.'));
    for (const f of list) {
      const suspended = f.accountStatus === 'SUSPENDED';
      body.append(el('article', { class: 'shift' },
        el('header', {}, el('div', {}, el('h3', {}, f.displayName), el('div', { class: 'meta' }, `${f.email}${f.phone ? ' · ' + f.phone : ''}`)),
          el('span', { class: 'pill ' + (suspended ? 'warn' : f.verified ? 'ok' : '') }, suspended ? 'gesperrt' : f.verified ? 'freigeschaltet' : 'nicht freigeschaltet')),
        el('div', { class: 'kvline' }, el('span', {}, 'Fähigkeiten: ' + (f.skills.join(', ') || '–')), el('span', {}, 'Bewertung: ' + (f.rating ? `★ ${f.rating} (${f.ratingCount})` : '–')),
          el('span', {}, `Zuverlässigkeit: ${Math.round(f.reliabilityScore * 100)} %`), el('span', {}, `No-Shows: ${f.noShowCount}`),
          el('span', {}, 'Hygiene: ' + (f.hygieneIssuedOn ? new Date(f.hygieneIssuedOn).toLocaleDateString('de-DE') : 'fehlt')), suspended ? el('span', {}, 'gesperrt bis ' + new Date(f.suspendedUntil).toLocaleDateString('de-DE')) : ''),
        el('div', { class: 'actions' },
          suspended ? act('Entsperren', () => post(`/freelancers/${f.id}/unsuspend`)) : act('Sperren …', async () => { const d = parseInt(prompt('Für wie viele Tage sperren?', '30'), 10); if (!d) throw new Error('Abgebrochen'); await post(`/freelancers/${f.id}/suspend`, { days: d }); }),
          f.verified ? act('Freischaltung entziehen', () => post(`/freelancers/${f.id}/unverify`)) : act('Freischalten', () => post(`/freelancers/${f.id}/verify`)),
          f.hygieneIssuedOn ? el('button', { class: 'secondary', onclick: (ev) => busy(ev.target, () => openBlob(`/admin/freelancers/${f.id}/hygiene-certificate`)) }, 'Nachweis ansehen') : '',
          act('Konto löschen …', async () => { if (!confirm(`Konto von ${f.displayName} endgültig anonymisieren? Das kann nicht rückgängig gemacht werden.`)) throw new Error('Abgebrochen'); await api(`/admin/users/${f.userId}`, { method: 'DELETE' }); }, 'secondary danger'))));
    }
  } else if (tabName === 'restaurants') {
    const list = await api('/admin/restaurants?q=' + q);
    if (!list.length) body.append(el('p', { class: 'hint' }, 'Keine Treffer.'));
    for (const r of list) body.append(el('article', { class: 'shift' },
      el('header', {}, el('div', {}, el('h3', {}, r.name), el('div', { class: 'meta' }, `${r.zip} ${r.city} · Betriebsnr. ${r.betriebsnummer || '–'} · ${r.owners.join(', ')}${r.rating ? ` · ★ ${r.rating} (${r.ratingCount})` : ''}`)),
        el('span', { class: 'pill ' + (r.blockedAt ? 'warn' : 'ok') }, r.blockedAt ? 'gesperrt' : 'aktiv')),
      el('div', { class: 'kvline' }, el('span', {}, `${r.shifts} Schichten`)),
      el('div', { class: 'actions' }, r.blockedAt ? act('Entsperren', () => post(`/restaurants/${r.id}/unblock`))
        : act('Sperren', async () => { if (!confirm(`${r.name} sperren? Offene Schichten werden zurückgezogen.`)) throw new Error('Abgebrochen'); await post(`/restaurants/${r.id}/block`); }))));
  } else {
    const list = await api('/admin/audit');
    body.append(el('p', { class: 'hint' }, 'Die letzten 100 Verwaltungsaktionen.'));
    for (const a of list) body.append(el('div', { class: 'kv' }, el('span', {}, `${new Date(a.createdAt).toLocaleString('de-DE')} · ${a.action}`), el('span', { class: 'meta' }, `${a.targetType} ${a.targetId.slice(0, 8)}…`)));
  }
}

loadInvite().then(() => start()).catch((e) => { logout(); show(e.message); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
