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
