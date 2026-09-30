'use strict';
// Aushilfen-App (PWA). Alle Ausgaben via textContent/el() – kein innerHTML → kein XSS.
const API = '/api/v1';
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignorieren */ } },
};
const json = (k, d) => { try { return JSON.parse(store.get(k)) ?? d; } catch { return d; } };
const state = { me: null, deck: [], pos: null, busy: false, apps: [], cert: null };
const formData = (form) => Object.fromEntries(new FormData(form));
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
  if (!res.ok) { const err = new Error(errorText(data)); err.body = data; throw err; }
  return data;
}
async function busy(btn, fn) { btn.disabled = true; show(''); try { await fn(); } catch (e) { if (e.message !== 'Abgebrochen') show(e.message); } finally { btn.disabled = false; } }
const fmtTime = (iso) => new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const euro = (c) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

// ---- Ansichten ----
function view(name) {
  $('landing').hidden = name !== 'landing'; $('auth').hidden = name !== 'auth'; $('verify').hidden = name !== 'verify'; $('appview').hidden = name !== 'app';
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
  e.preventDefault(); const fd = new FormData(e.target);
  const file = fd.get('certFile'), issuedOn = fd.get('certDate');
  fd.delete('certFile'); fd.delete('certDate');
  const f = Object.fromEntries(fd);
  busy(e.submitter, async () => {
    const r = await api('/freelancers/register', { method: 'POST', body: { ...f, skills: fd.getAll('skills'), privacyConsent: fd.has('privacyConsent') } });
    state.cert = { file, issuedOn }; // wird nach der Bestätigung der Codes hochgeladen
    openVerify('signup', r.verificationToken);
  });
});
async function onSession(token) {
  store.set('jobs_token', token);
  if (state.cert) {
    try { await uploadCert(state.cert.file, state.cert.issuedOn); state.cert = null; }
    catch (e) { await start(); show('Der Hygienenachweis konnte nicht hochgeladen werden (' + e.message + ') – bitte im Reiter „Profil“ erneut versuchen.'); return; }
  }
  await start();
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

// ---- Hygienenachweis: Foto verkleinern (Handyfotos sind oft > 5 MB), PDF unverändert ----
const readB64 = (blob) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => fail(new Error('Datei nicht lesbar')); r.readAsDataURL(blob); });
async function fileToBase64(file) {
  if (!file) throw new Error('Keine Datei gewählt');
  if (file.type === 'application/pdf') { if (file.size > 5e6) throw new Error('PDF zu groß (max. 5 MB)'); return readB64(file); }
  if (!file.type.startsWith('image/')) throw new Error('Nur Foto (JPG/PNG) oder PDF erlaubt');
  const bmp = await createImageBitmap(file), k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = el('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return readB64(await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85)));
}
async function uploadCert(file, issuedOn) {
  await api('/freelancers/me/hygiene-certificate', { method: 'PUT', body: { file: await fileToBase64(file), issuedOn } });
}

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
    const msg = !p ? '' : !p.verified ? 'Lade zuerst deinen Hygienenachweis im Reiter „Profil“ hoch – danach siehst du sofort passende Schichten.'
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
const APP_LABEL = { PENDING: 'Warten auf Antwort', ACCEPTED: 'Bestätigt', REJECTED: 'Nicht berücksichtigt', CANCELLED: 'Von dir abgesagt' };
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
    if (status === 'ACCEPTED' && s.status === 'MATCHED' && new Date(s.startTime) > new Date()) {
      const hours = (new Date(s.startTime) - Date.now()) / 3.6e6;
      c.append(el('div', { class: 'actions' }, el('button', { class: 'secondary danger', onclick: (ev) => busy(ev.target, async () => {
        const warn = hours < 24 ? 'ACHTUNG: Weniger als 24 Stunden vor Beginn. Kurzfristige Absagen senken deine Zuverlässigkeit; bei wiederholten Absagen wird dein Konto gesperrt.\n\n' : 'Eine frühe Absage ist kostenlos.\n\n';
        if (!confirm(warn + 'Zusage wirklich absagen?')) throw new Error('Abgebrochen');
        const r = await api(`/marketplace/shifts/${s.id}/cancel-assignment`, { method: 'POST', body: {} });
        state.me = await api('/freelancers/me'); setBanner(); renderProfile();
        await loadApps(); await loadDeck().catch(() => {});
        show(r.suspended ? 'Abgesagt – dein Konto wurde wegen wiederholter kurzfristiger Absagen vorübergehend gesperrt.' : r.late ? 'Abgesagt. Deine Zuverlässigkeit wurde wegen der kurzfristigen Absage etwas gesenkt.' : 'Abgesagt – der Betrieb wurde informiert.', !r.suspended);
      }) }, 'Zusage absagen')));
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
    kv('Konto', p.accountStatus === 'SUSPENDED' ? 'Gesperrt bis ' + new Date(p.suspendedUntil).toLocaleDateString('de-DE') : 'Aktiv'),
    kv('Hygiene-Belehrung', p.hygiene ? 'ausgestellt am ' + new Date(p.hygiene.issuedOn).toLocaleDateString('de-DE') : 'fehlt'));
  const form = el('form', { class: 'form cert-form', hidden: '' },
    el('label', {}, 'Foto oder PDF der Belehrung (§ 43 IfSG)', el('input', { type: 'file', name: 'certFile', accept: 'image/jpeg,image/png,application/pdf', required: '' })),
    el('label', {}, 'Ausgestellt am', el('input', { type: 'date', name: 'certDate', required: '' })),
    el('button', { class: 'btn accent block' }, 'Hochladen'));
  form.addEventListener('submit', (ev) => { ev.preventDefault(); busy(ev.submitter, async () => {
    await uploadCert(form.elements.certFile.files[0], form.elements.certDate.value);
    state.me = await api('/freelancers/me'); setBanner(); renderProfile(); await loadDeck();
    show(p.verified ? 'Neuer Nachweis gespeichert.' : 'Nachweis gespeichert – du bist freigeschaltet und kannst Schichten annehmen!', true);
  }); });
  if (!p.hygiene) form.hidden = false;
  else box.append(el('div', { class: 'actions' }, el('button', { class: 'link', type: 'button', onclick: () => { form.hidden = !form.hidden; } }, 'Neuen Nachweis hochladen')));
  box.append(form);
  const d = $('danger'), pw = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: '', placeholder: 'Passwort zur Bestätigung' });
  const del = el('form', { class: 'form', hidden: '' }, pw, el('button', { class: 'btn ghost danger' }, 'Konto endgültig löschen'));
  del.addEventListener('submit', (ev) => { ev.preventDefault(); busy(ev.submitter, async () => {
    if (!confirm('Konto wirklich endgültig löschen? Das kann nicht rückgängig gemacht werden.')) return;
    await api('/freelancers/me', { method: 'DELETE', body: { password: pw.value } }); logout(); show('Dein Konto wurde gelöscht. Alles Gute!', true);
  }); });
  d.replaceChildren(el('h2', {}, 'Konto'), el('p', { class: 'hint' }, 'Du kannst dein Konto jederzeit löschen. Profildaten und Hygienenachweis werden entfernt; gesetzlich aufbewahrungspflichtige Meldedaten früherer Schichten bleiben erhalten.'),
    el('button', { class: 'link danger', type: 'button', onclick: () => { del.hidden = !del.hidden; } }, 'Konto löschen …'), del);
  TotpUI.mount($('security'), { api, show, enabled: p.totpEnabled, onChange: async () => { state.me = await api('/freelancers/me'); renderProfile(); } });
}
function setBanner() {
  const p = state.me, b = $('banner'); b.className = 'banner'; b.hidden = false;
  if (p.accountStatus === 'SUSPENDED') { b.classList.add('err'); b.textContent = `Dein Konto ist bis ${new Date(p.suspendedUntil).toLocaleDateString('de-DE')} gesperrt, weil du zu einer bestätigten Schicht nicht erschienen bist.`; }
  else if (!p.verified) b.textContent = 'Willkommen! Lade noch deinen Hygienenachweis im Reiter „Profil“ hoch – dann kannst du sofort Schichten annehmen.';
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
