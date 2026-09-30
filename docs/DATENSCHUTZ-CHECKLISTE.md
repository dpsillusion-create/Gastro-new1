# Datenschutz-Checkliste für SmartShift Swap (Arbeitsgrundlage für Jurist / Datenschutzbeauftragte)

*Technische Zusammenstellung des tatsächlich Implementierten. Keine Rechtsberatung – die rechtliche Bewertung muss ein Fachmann vornehmen.*

## 1. Wer verarbeitet was?
| Gruppe | Daten | Zweck | Mögliche Rechtsgrundlage (prüfen!) |
|---|---|---|---|
| Betriebe | E-Mail, Handynummer, Passwort (nur als Hash), Betriebsname/-adresse, Betriebsnummer, Zustimmung (Zeitpunkt, Version) | Konto, Ausschreiben, Sofortmeldung | Vertrag (Art. 6 Abs. 1 b) |
| Aushilfen | Name, E-Mail, Handynummer, Wohnort (PLZ/Ort → Koordinaten), Geburtsdatum, **Sozialversicherungsnummer**, **Steuer-ID**, Fähigkeiten, Bewertungen, Zuverlässigkeit, Einsatz-/Bewerbungsverlauf | Vermittlung, Sofortmeldung, Qualitätssicherung | Vertrag (b), rechtliche Pflicht für Meldedaten (c), Einwilligung für Nachweis (a) |
| Aushilfen | **Hygienenachweis** (Foto/PDF der Belehrung nach § 43 IfSG), Ausstellungsdatum | Nachweispflicht des Arbeitgebers | Einwilligung (a) / rechtliche Pflicht (c) – prüfen, ob „Gesundheitsdaten“ (Art. 9) |
| Alle | Sicherheitsdaten: Authenticator-Secret (verschlüsselt), Fehlversuche, Push-Abonnements, Protokoll der Verwaltungsaktionen | Sicherheit, Missbrauchsschutz | berechtigtes Interesse (f) |

## 2. Empfänger / Auftragsverarbeiter (Verträge nach Art. 28 prüfen)
- **Server-Hoster** (dein Anbieter, Standort prüfen) – Speicherung aller Daten.
- **E-Mail-Anbieter (SMTP)** – Inhalt der Codes/Benachrichtigungen, Empfängeradressen.
- **OpenStreetMap Nominatim** – Adresse/PLZ+Ort bei Registrierung (Umwandlung in Koordinaten); Betreiber in Großbritannien/EU prüfen.
- **Push-Dienste der Browser** (Google, Apple, Mozilla, Microsoft) – nur verschlüsselte Benachrichtigung + Gerätekennung, nur bei aktivierten Push-Nachrichten.
- **Betriebe** erhalten: Name, Bewertung, Fähigkeiten, Hygiene-Datum vor der Zusage; Hygienenachweis-Dokument, Sofortmeldedaten (inkl. SV-Nummer, Steuer-ID) erst nach der Zusage.
- Schriften werden **selbst gehostet** (keine Verbindung zu Google Fonts). Keine Tracking-/Analyse-Dienste, keine Cookies außer Sitzungsdaten im Browser-Speicher.

## 3. Technische und organisatorische Maßnahmen (umgesetzt)
- SV-Nummer, Steuer-ID, Hygienenachweise, Authenticator-Secrets: **AES-256-GCM verschlüsselt** in der Datenbank (Schlüssel getrennt gesichert).
- Passwörter: scrypt-Hash. Zwei-Faktor-Anmeldung (Authenticator-App oder E-Mail-Code); Verwaltung nur mit Authenticator-App.
- Schutz vor Raten (Limits pro IP und pro Konto), kurzlebige Codes, Sitzungen werden bei Passwort-Reset/Löschung ungültig.
- Rollenmodell (Inhaber/Manager/Aushilfe/Admin), Zugriffsprüfung in der Datenbank bei jeder Anfrage; Dokumentabruf nur nach Zusage und protokolliert (Admin).
- HTTPS (nginx/Let's Encrypt), strikte Content-Security-Policy, Rate-Limits, Eingabevalidierung, kein SQL ohne Parameter.
- Protokoll der Verwaltungsaktionen; tägliche Datenbank-Sicherungen (`deploy/backup.sh`).

## 4. Betroffenenrechte (umgesetzt)
- **Auskunft/Übertragbarkeit:** Profil → „Meine Daten herunterladen“ (JSON, passwortgeschützt) – für Aushilfen. *Für Betriebe bisher nicht als Download (auf Anfrage manuell).*
- **Löschung:** Aushilfen per Knopf im Profil, Verwaltung für alle Konten (Anonymisierung). Aufbewahrungspflichtige Melde-/Einsatzdaten bleiben erhalten (Frist mit Steuerberater klären).
- **Berichtigung:** Pflichtangaben können erneut eingereicht werden (Profil); übrige Änderungen über den Support.
- **Widerruf Einwilligung / Push:** Push jederzeit pro Gerät abschaltbar.

## 5. Offene Fragen für den Juristen (bitte klären lassen)
1. **Rolle:** Seid ihr Verantwortlicher, gemeinsam Verantwortliche mit den Betrieben oder Auftragsverarbeiter? Wer ist *Arbeitgeber* (vermutlich der Betrieb) – Wirkung auf Haftung, AGB, Vermittlungsvertrag, ggf. Arbeitnehmerüberlassung/Scheinselbständigkeit.
2. **Gesundheitsdaten?** Gilt der Hygienenachweis (Belehrung nach § 43 IfSG) als besondere Kategorie (Art. 9)? Falls ja: Rechtsgrundlage und Einwilligungstext anpassen.
3. **Aufbewahrungsfristen** für Meldedaten, Einsatzdaten, Hygienenachweise und Protokolle; Löschkonzept.
4. **Drittlandtransfer** (Push-Dienste, ggf. Hoster/E-Mail-Anbieter) und nötige Garantien.
5. **Datenschutzfolgenabschätzung** nötig? (Verarbeitung von SV-Nummern/Nachweisen in größerem Umfang, Bewertungs-/Sperrsystem = automatisierte Entscheidung? Art. 22 prüfen – Sperre nach No-Show wird automatisch gesetzt.)
6. **Texte:** Datenschutzerklärung (alle Punkte oben), Nutzungsbedingungen/AGB für den Marktplatz (Version ist in `backend/src/config.ts` → `TERMS_VERSION`), Impressum, Einwilligungstexte; Verzeichnis der Verarbeitungstätigkeiten; AV-Verträge; Meldeweg für Datenpannen (72 Stunden).
7. **Sofortmeldung:** Wer meldet (Betrieb über sein Abrechnungssystem)? Haftungs-/Hinweistexte in den E-Mails und der Oberfläche prüfen.
