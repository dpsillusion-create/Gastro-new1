'use strict';
// Gemeinsamer Baustein beider Oberflächen: Authenticator-App (TOTP) einrichten und entfernen.
// Ausgaben nur über DOM/textContent (kein innerHTML). Erwartet `api(path, {method, body})` der Seite.
window.TotpUI = (() => {
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) k === 'class' ? (n.className = v) : k.startsWith('on') ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v);
    n.append(...kids); return n;
  };
  const run = (btn, show, fn) => { btn.disabled = true; show(''); return fn().catch((e) => show(e.message)).finally(() => { btn.disabled = false; }); };
  const codeInput = () => el('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '\\d{6}', required: '', placeholder: '6-stelliger Code' });

  function mount(box, { api, show, enabled, onChange }) {
    if (!box) return;
    box.replaceChildren(el('h2', {}, 'Sicherheit'));
    if (enabled) {
      const form = el('form', { class: 'form', hidden: '' },
        el('label', {}, 'Passwort', el('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: '' })),
        el('label', {}, 'Aktueller Code aus der App', codeInput()),
        el('button', { class: 'btn ghost' }, 'Authenticator entfernen'));
      form.addEventListener('submit', (e) => { e.preventDefault(); run(e.submitter, show, async () => {
        await api('/auth/totp/disable', { method: 'POST', body: { password: form.elements.password.value, code: form.elements.code.value } });
        show('Authenticator entfernt – die Anmeldung nutzt wieder den Code per E-Mail.', true); await onChange();
      }); });
      box.append(el('p', { class: 'hint' }, '✓ Zwei-Faktor-Anmeldung mit Authenticator-App ist aktiv.'),
        el('button', { class: 'link', type: 'button', onclick: () => { form.hidden = !form.hidden; } }, 'Entfernen …'), form);
      return;
    }
    const setup = el('div', { hidden: '' });
    box.append(el('p', { class: 'hint' }, 'Aktuell schicken wir dir bei jeder Anmeldung einen Code per E-Mail. Mit einer Authenticator-App (z. B. Google Authenticator, Microsoft Authenticator oder Authy) meldest du dich schneller und noch sicherer an.'),
      el('button', { class: 'btn ghost', type: 'button', onclick: (e) => run(e.target, show, async () => {
        const r = await api('/auth/totp/setup', { method: 'POST', body: {} });
        const form = el('form', { class: 'form' }, el('label', {}, 'Code aus der App', codeInput()), el('button', { class: 'btn accent' }, 'Aktivieren'));
        form.addEventListener('submit', (ev) => { ev.preventDefault(); run(ev.submitter, show, async () => {
          await api('/auth/totp/enable', { method: 'POST', body: { code: form.elements.code.value } });
          show('Authenticator aktiviert. Ab jetzt meldest du dich mit dem Code aus der App an.', true); await onChange();
        }); });
        setup.replaceChildren(
          el('ol', { class: 'hint' }, el('li', {}, 'Authenticator-App auf dem Handy öffnen und „Konto hinzufügen“ wählen.'), el('li', {}, 'Diesen QR-Code scannen (oder den Schlüssel unten eintippen).'), el('li', {}, 'Den angezeigten 6-stelligen Code hier eingeben.')),
          el('img', { class: 'qr', src: r.qr, alt: 'QR-Code für die Authenticator-App', width: '240', height: '240' }),
          el('p', { class: 'secret' }, r.secret.match(/.{1,4}/g).join(' ')), form);
        setup.hidden = false; e.target.hidden = true;
      }) }, 'Authenticator-App einrichten'), setup);
  }
  return { mount };
})();
