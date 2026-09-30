'use strict';
// Gemeinsamer Baustein beider Oberflächen: Push-Nachrichten auf diesem Gerät ein-/ausschalten. Erwartet `api(path, opts)` der Seite.
window.PushUI = (() => {
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) k === 'class' ? (n.className = v) : k.startsWith('on') ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v);
    n.append(...kids); return n;
  };
  const toBytes = (s) => { const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function mount(box, { api, show, swScope }) {
    if (!box) return;
    let key;
    try { key = (await api('/push/public-key')).publicKey; } catch { box.hidden = true; return; } // auf dem Server nicht eingerichtet → ausblenden
    box.hidden = false; box.replaceChildren(el('h2', {}, 'Benachrichtigungen'));
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) {
      box.append(el('p', { class: 'hint' }, 'Dieser Browser unterstützt keine Push-Nachrichten.' + (ios && !standalone ? ' Auf dem iPhone: Seite über „Teilen → Zum Home-Bildschirm“ hinzufügen und von dort öffnen.' : ''))); return;
    }
    const reg = await navigator.serviceWorker.getRegistration(swScope), sub = reg ? await reg.pushManager.getSubscription() : null;
    const run = (btn, fn) => { btn.disabled = true; show(''); return fn().catch((e) => show(e.message)).finally(() => { btn.disabled = false; }); };
    box.append(el('p', { class: 'hint' }, 'Wir schicken dir eine Nachricht aufs Gerät, sobald es etwas Neues gibt (z. B. Zusage, neue Bewerbung). Auf dem Sperrbildschirm steht nur eine kurze Überschrift.'));
    if (Notification.permission === 'denied') { box.append(el('p', { class: 'hint' }, 'Benachrichtigungen sind für diese Seite im Browser blockiert. Erlaube sie in den Browser-Einstellungen, um sie zu aktivieren.')); return; }
    if (sub) {
      box.append(el('p', { class: 'hint' }, '✓ Auf diesem Gerät aktiv.'), el('button', { class: 'link', type: 'button', onclick: (e) => run(e.target, async () => {
        await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); await mount(box, { api, show, swScope });
      }) }, 'Auf diesem Gerät ausschalten'));
      return;
    }
    if (ios && !standalone) box.append(el('p', { class: 'hint' }, 'iPhone: Push funktioniert nur, wenn du die Seite über „Teilen → Zum Home-Bildschirm“ hinzufügst und von dort öffnest.'));
    box.append(el('button', { class: 'btn ghost', type: 'button', onclick: (e) => run(e.target, async () => {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Ohne Erlaubnis können wir dir keine Nachrichten schicken.');
      const r = reg || (await navigator.serviceWorker.ready);
      const s = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
      await api('/push/subscribe', { method: 'POST', body: { endpoint: s.endpoint, keys: { p256dh: b64url(s.getKey('p256dh')), auth: b64url(s.getKey('auth')) } } });
      show('Benachrichtigungen sind aktiv.', true); await mount(box, { api, show, swScope });
    }) }, 'Auf diesem Gerät aktivieren'));
  }
  return { mount };
})();
