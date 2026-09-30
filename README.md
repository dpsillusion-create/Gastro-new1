# Gastro – SmartShift Swap

Personalmarktplatz für Spontanaushilfen (Kern-Backend, Python ≥ 3.9, nur Standardbibliothek).

- `smartshift/schema.py` – Tabellen `shift_marketplace`, `freelancer_profile` (+ Bewerbungen, temporäres
  Zeiterfassungsprofil, Sofortmeldungs-Datensatz, Push-Nachrichten)
- `smartshift/matching.py` / `geo.py` – Matchmaking: verifiziert, ≤ 25 km (Haversine), Skill-Tag passt zur Rolle
- `smartshift/service.py` – Flow: `publish_shift` → `feed`/`swipe` → `applicants` → `confirm` → `complete`

`confirm` legt atomar an: temporäres Profil (Zeiterfassung/Dienstplan), Sofortmeldungs-Datensatz, Push-Nachricht.

Tests: `python3 -m unittest discover -s tests -v`

## Offen / Annahmen
- Die Sofortmeldung wird nur als Datensatz (`immediate_notification`, Status `READY`) erzeugt; die
  Übermittlung an die DEÜV-Schnittstelle und die Push-/Geräteanbindung sind nicht implementiert.
- Die Sozialversicherungsnummer liegt hier im Klartext – für Produktion verschlüsseln (DSGVO).
- Rollen→Tag-Zuordnung in `matching.ROLE_TAGS` ist ein Startwert.

## Backend (TypeScript / Express / Prisma) – `backend/`
`npm install && cp .env.example .env && npx prisma migrate dev && npm run dev` · Tests: `npm test`

| Endpoint | Zweck |
|---|---|
| `POST /api/v1/marketplace/shifts` | Wirt schreibt Schicht aus (Restaurant-Zugriff wird per `RestaurantMember` geprüft) |
| `GET /api/v1/marketplace/search` | Umkreissuche (Bounding-Box + Haversine in SQL, max. 25 km, verifizierte Skills) |
| `POST /api/v1/marketplace/shifts/:id/apply` | Bewerben – nur mit validierten SV-Nr./Steuer-ID/Geburtsdatum, nicht gesperrt |
| `POST /api/v1/marketplace/shifts/:id/accept` | Match: atomar OPEN→MATCHED, Hook für Dienstplan/Zeiterfassung/Sofortmeldung, Webhook `trigger_sofortmeldung_generation` (Outbox) |
| `GET /api/v1/marketplace/shifts/:id/sofortmeldung-export` | DEÜV-Meldedaten für den Arbeitgeber |
| `PUT /api/v1/freelancers/me/compliance` | Pflichtangaben einreichen + validieren |

Zuverlässigkeit: `services/reliability.ts` – `registerNoShow` (−0,25, bei < 0,90 → `SUSPENDED` für 30 Tage),
`recordClockIn` (vom Terminal), `sweepNoShows` (Cron alle ~5 min). Nach Ablauf der Sperre Bewährungs-Score 0,90.

**Nicht gegen eine echte Datenbank getestet** (Typecheck, Schema-Validierung und Unit-Tests laufen). Vor Produktivbetrieb prüfen:
DEÜV-Schlüssel (Personengruppe 110, Tätigkeitsschlüssel), die Prüfziffernlogik mit echten Testdaten, Auth-Anbindung (JWT `sub`).

**Durchlauf-Test gegen die echte Datenbank:** `cd backend && BASE_URL=http://127.0.0.1:3100 npm run smoke`
(braucht die Umgebungsvariablen des Servers; legt nur Testdaten `@smoketest.invalid` an und löscht sie wieder).
Mindestlohn: `MIN_WAGE_CENTS` (Standard 1390 = 13,90 €/h, Stand 2026).
