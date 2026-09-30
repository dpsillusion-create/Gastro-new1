# Testdrehbuch – SmartShift Swap (für den ersten Gesamttest)

Ziel: den kompletten Ablauf einmal von A bis Z durchspielen und aufschreiben, was hakt. Plane ca. 1–1,5 Stunden ein.
**Tipp:** Nutze zwei Geräte (Computer für den Betrieb, Handy für die Aushilfe) und zwei Browser-Profile bzw. ein privates Fenster.

## 0. Vorbereitung (einmalig, auf dem Server)
1. Neuesten Stand einspielen – **das Skript zuerst kopieren**, weil es sich beim Aktualisieren selbst überschreibt:
   `cp /opt/smartshift/deploy/deploy.sh /tmp/deploy.sh && BRANCH=claude/cool-cray-gv7yoq bash /tmp/deploy.sh`
   Am Ende muss „✔ SmartShift läuft und die Datenbank ist verbunden.“ stehen.
2. `/etc/smartshift.env` prüfen: SMTP-Daten vorhanden, `PUBLIC_URL=https://jobs.gastroevolution.de`, **kein** `NOTIFY_MODE=log`.
   Optional: `ALERT_EMAIL=deine@adresse.de` (Alarm bei Störung), danach `bash /opt/smartshift/deploy/install-cron.sh` (Backup + Überwachung).
3. Testmail: `cd /opt/smartshift/backend && set -a && . /etc/smartshift.env && set +a && npx tsx scripts/test-mail.ts deine@adresse.de`
4. Du brauchst **4 E-Mail-Adressen** (Postfächer oder Aliase, die du lesen kannst): Betrieb, Manager, Aushilfe A, Aushilfe B.

## 1. Betrieb und Verwaltung
- [ ] `https://jobs.gastroevolution.de/app/` → „Betrieb registrieren“. Adresse muss gefunden werden (echte Straße). Betriebsnummer: 8 beliebige Ziffern.
- [ ] Code aus der E-Mail eingeben → Dashboard „Schichten verwalten“.
- [ ] Einstellungen → **Authenticator-App** einrichten (QR-Code scannen). Abmelden, wieder anmelden: jetzt Code aus der App.
- [ ] Auf dem Server dich zum Administrator machen: `npx tsx scripts/admin.ts make-admin deine@mail.de` → Seite neu laden → Knopf „Verwaltung“ erscheint.

## 2. Schicht ausschreiben
- [ ] Schicht **mit 2 Personen** ausschreiben (Beginn in ~40 Minuten, Ende 10 Minuten später – so kommst du heute noch zu Anwesenheit und Bewertung). Stundensatz unter 13,90 € muss abgelehnt werden.
- [ ] Es erscheinen zwei Karten „Stelle 1 von 2“ / „Stelle 2 von 2“. Tätigkeitsschlüssel leer lassen (siehe Punkt 4).

## 3. Aushilfe A und B registrieren (am Handy)
- [ ] `https://jobs.gastroevolution.de/jobs/` → Registrieren. Testwerte, die formal durchgehen: SV-Nummer `15070649C103`, Geburtsdatum `07.06.1949`, Steuer-ID `86095742719` (für A); für B dieselben Werte sind ok.
- [ ] Hygienenachweis: irgendein Foto/PDF hochladen. Code per E-Mail bestätigen → sofort freigeschaltet, Schicht erscheint als **eine Karte „2 Plätze frei“**.
- [ ] Wischen: nach rechts = bewerben. Bei A und B. Unter „Bewerbungen“ steht „Warten auf Antwort“, die Adresse ist noch verborgen.
- [ ] Handy: Profil → Benachrichtigungen aktivieren (auf dem iPhone erst „Zum Home-Bildschirm“). Zusätzlich ggf. „Zum Startbildschirm hinzufügen“.

## 4. Bestätigen und Sofortmeldung
- [ ] Betrieb: E-Mail „Neue Bewerbung“ (und Push) angekommen? Bewerber A bestätigen.
- [ ] Aushilfe A: E-Mail/Push „Bestätigt“ mit Adresse. Bewerbungen → „Bestätigt“ + Adresse + Karte.
- [ ] Bewerber B ist auf Stelle 2 **nachgerückt** – Betrieb bestätigt B oder „Ablehnen“ (Aushilfe B bekommt E-Mail).
- [ ] Betrieb: Karte „Sofortmeldung“: Es fehlt der Tätigkeitsschlüssel → 9 Ziffern eintragen → „Meldedaten exportieren“ (Datei prüfen) → „Als gemeldet markieren“.
- [ ] E-Mail „Sofortmeldung abgeben“ war angekommen.

## 5. Absagen
- [ ] Aushilfe B sagt die zugesagte Schicht ab („Zusage absagen“). Bei Beginn < 24 h erscheint die Warnung; danach Zuverlässigkeit im Profil < 100 %. Betrieb bekommt E-Mail, die Schicht ist wieder „Offen“.
- [ ] Betrieb: bei einer anderen Zusage „Aushilfe austauschen“ bzw. „Schicht absagen“ ausprobieren.

## 6. Schichtverlauf und Bewertung
- [ ] Ab 30 Minuten vor Beginn: Betrieb → „Ist erschienen“. Nach Schichtende: Sterne vergeben, Schicht ist „Abgeschlossen“.
- [ ] Aushilfe: Bewerbungen → „Wie war der Betrieb?“ → Sterne. Betrieb sieht oben „Bewertung durch Aushilfen“.
- [ ] (Optional) No-Show: eine weitere Schicht, 15 Minuten nach Beginn „Nicht erschienen“ → Aushilfe wird gesperrt, bekommt E-Mail. Entsperren in der Verwaltung.

## 7. Team
- [ ] Betrieb → Einstellungen → Team: Manager einladen (E-Mail). Link öffnen (privates Fenster) → registrieren → der Manager sieht die Schichten, kann aber **keine** Schicht ausschreiben.

## 8. Verwaltung und Datenschutz
- [ ] Verwaltung: Übersicht, Aushilfen suchen, „Nachweis ansehen“, sperren/entsperren, Protokoll.
- [ ] Aushilfe: Profil → „Meine Daten herunterladen“ (Datei prüfen). Aushilfe: „Konto löschen“. Betrieb: Einstellungen → Datenauskunft/Konto löschen.
- [ ] Passwort vergessen (beim Login) mit Code per E-Mail.

## Wenn etwas nicht klappt – bitte notieren
Uhrzeit, was du geklickt hast, Meldung im roten/grünen Kasten, Screenshot. Auf dem Server:
`journalctl -u smartshift -n 80 --no-pager` (Fehler der Website) und `journalctl -u smartshift-worker -n 40 --no-pager` (Hintergrundaufgaben).
