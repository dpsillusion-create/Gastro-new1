# GastroEvolution – SmartShift Swap

Lokaler Marktplatz für Spontanaushilfen in der Gastronomie: Betriebe schreiben kurzfristig offene Schichten aus,
verifizierte Aushilfen aus der Region (max. 25 km) nehmen sie per Wisch an. Bei Zusage entstehen automatisch
ein temporärer Mitarbeiter, ein Dienstplan-Eintrag und die Daten für die gesetzliche Sofortmeldung.

Live: **https://jobs.gastroevolution.de** – Betriebe unter `/app/`, Aushilfen (installierbare Handy-Web-App) unter `/jobs/`.

## Aufbau
| Ordner | Inhalt |
|---|---|
| `backend/` | Node.js/Express-API (TypeScript), Prisma/PostgreSQL, Worker, Tests |
| `backend/public/` | Oberfläche für Betriebe und Verwaltung (`/app/`), Aushilfen-App (`/jobs/`), Schriften (selbst gehostet) |
| `backend/scripts/` | `smoke.ts` (Durchlauf-Test), `admin.ts` (Verwaltung per Kommandozeile) |
| `deploy/` | Deploy-Skript, systemd-Dienste, nginx-Konfiguration, Backup-Skript, Serveranleitung |

Start lokal: `cd backend && npm install && cp .env.example .env && npx prisma migrate dev && npm run dev`

## Funktionen
**Betriebe:** registrieren (E-Mail-Code), anmelden mit zweitem Faktor, Schichten ausschreiben (Mindestlohn-Prüfung), Bewerber mit
Bewertung und Hygiene-Hinweis sehen, bestätigen, Anwesenheit melden, Schicht abschließen und bewerten, Meldedaten der Sofortmeldung
exportieren, Hygienenachweis der zugesagten Aushilfe einsehen, API-Schlüssel für das Zeiterfassungsterminal verwalten.

**Aushilfen:** registrieren (SV-Nummer, Steuer-ID, Geburtsdatum mit Prüfziffern, Hygienenachweis-Upload → automatische Freischaltung),
Schichten im Umkreis per Wisch annehmen, Bewerbungen verfolgen (Adresse erst nach Zusage), Profil mit Bewertung und Zuverlässigkeit, Konto löschen.

**Sicherheit:** Passwort + zweiter Faktor (Authenticator-App/TOTP oder E-Mail-Code), Passwort-Reset per E-Mail-Code, Brute-Force-Schutz,
SV-Nummer/Steuer-ID/Nachweise/Secrets AES-256-GCM-verschlüsselt, Zwischen-Tokens sind keine Sitzungen, Rate-Limits, strikte CSP.

**Zuverlässigkeit:** No-Show → Score −0,25 und 30 Tage Sperre. Automatisch nur bei Betrieben mit angebundenem Terminal (API-Schlüssel),
sonst entscheidet der Wirt selbst (E-Mail-Erinnerung 20 Min. nach Schichtbeginn).

**Verwaltung** (Nutzer mit `make-admin`): Übersicht, Aushilfen und Betriebe suchen/sperren/freischalten, Hygienenachweise einsehen,
Konten anonymisieren (DSGVO), Protokoll aller Verwaltungsaktionen.

**E-Mails:** neue Bewerbung (Wirt), Zusage mit Adresse / Schicht besetzt / Schicht zurückgezogen (Aushilfe), Sperre, Anwesenheits-Erinnerung.

## API (Auszug)
| Bereich | Endpunkte |
|---|---|
| System | `GET /` (JSON-Status, Browser → `/app/`), `GET /health` (prüft die Datenbank) |
| Anmeldung | `POST /api/v1/auth/register`, `/verify`, `/login`, `/login/verify`, `/resend`, `/password/forgot`, `/password/reset`, `GET /auth/me`, `POST /auth/totp/setup|enable|disable` |
| Aushilfen | `POST /api/v1/freelancers/register`, `GET /me`, `GET /me/applications`, `PUT /me/hygiene-certificate`, `DELETE /me` |
| Marktplatz | `POST /api/v1/marketplace/shifts`, `GET /search`, `POST /shifts/:id/apply|withdraw|accept|cancel|attendance|complete`, `GET /my-shifts`, `/shifts/:id/applications|sofortmeldung-export|hygiene-certificate` |
| Betriebe | `GET/POST/DELETE /api/v1/restaurants/:id/api-keys` |
| Terminal | `POST /api/v1/integrations/clock-in`, `GET /integrations/shifts` (API-Schlüssel `Authorization: Bearer ge_…`) |
| Verwaltung | `/api/v1/admin/stats|freelancers|restaurants|audit|users/:id` |

## Tests
`cd backend && npm test` (Einheitentests: Geo, Prüfziffern, No-Show-Rechnung, TOTP nach RFC 6238).
Durchlauf gegen echte Datenbank und laufenden Server: `npm run smoke` (Umgebung wie der Server, dazu `OTP_TEST_CODE=123456 NOTIFY_MODE=log`;
legt nur Testdaten `@smoketest.invalid` an und räumt sie weg).

## Bewusst nicht enthalten / offen
- Die **Übermittlung der Sofortmeldung** an die Rentenversicherung: es entstehen nur exportfertige Meldedaten (DEÜV-Schlüssel vor Produktivbetrieb prüfen).
- **Push-Nachrichten** aufs Handy (aktuell: E-Mail, die Aushilfen-App fragt alle 30 s nach, solange sie offen ist).
- Rechtstexte für diese Seite (Impressum/Datenschutz verlinken auf gastroevolution.de) – rechtlich prüfen lassen.
- Ob und wie lange Hygienenachweis und Meldedaten aufbewahrt werden müssen, klären Steuerberater/Gesundheitsamt.
