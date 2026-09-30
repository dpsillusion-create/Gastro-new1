import json
from datetime import datetime

from . import matching


class SwapError(Exception):
    pass


class SmartShiftService:
    def __init__(self, conn):
        self.db = conn

    # --- Gastronom -------------------------------------------------------
    def publish_shift(self, restaurant_id, role, hourly_rate, start_time, end_time, requirements=""):
        if datetime.fromisoformat(end_time) <= datetime.fromisoformat(start_time):
            raise SwapError("Ende muss nach Beginn liegen")
        if hourly_rate <= 0:
            raise SwapError("Stundensatz muss positiv sein")
        cur = self.db.execute(
            "INSERT INTO shift_marketplace (restaurant_id, role, hourly_rate, start_time, end_time,"
            " requirements) VALUES (?,?,?,?,?,?)",
            (restaurant_id, role, hourly_rate, start_time, end_time, requirements))
        self.db.commit()
        return cur.lastrowid

    def applicants(self, shift_id):
        """Kurzprofile der Bewerber (Bewertung, Skills) für die Entscheidung des Wirts."""
        return self.db.execute(
            "SELECT a.id application_id, f.id freelancer_id, f.name, f.skills, f.rating_score,"
            " f.rating_count FROM shift_application a JOIN freelancer_profile f ON f.id=a.freelancer_id"
            " WHERE a.shift_id=? AND a.status='PENDING' ORDER BY f.rating_score DESC", (shift_id,)
        ).fetchall()

    def confirm(self, shift_id, freelancer_id):
        shift = self._shift(shift_id)
        if shift["status"] != "OPEN":
            raise SwapError("Schicht nicht mehr offen")
        app = self.db.execute(
            "SELECT * FROM shift_application WHERE shift_id=? AND freelancer_id=? AND status='PENDING'",
            (shift_id, freelancer_id)).fetchone()
        if not app:
            raise SwapError("Keine offene Bewerbung")
        f = self.db.execute("SELECT * FROM freelancer_profile WHERE id=?", (freelancer_id,)).fetchone()
        r = self.db.execute("SELECT * FROM restaurant WHERE id=?", (shift["restaurant_id"],)).fetchone()
        if not f["social_security_number"]:
            raise SwapError("Sozialversicherungsnummer fehlt – Sofortmeldung nicht möglich")
        with self.db:
            self.db.execute("UPDATE shift_marketplace SET status='MATCHED', matched_freelancer_id=?"
                            " WHERE id=?", (freelancer_id, shift_id))
            self.db.execute("UPDATE shift_application SET status='CONFIRMED' WHERE id=?", (app["id"],))
            self.db.execute("UPDATE shift_application SET status='REJECTED' WHERE shift_id=? AND id!=?",
                            (shift_id, app["id"]))
            # Temporäres Profil für Zeiterfassung + Dienstplan
            self.db.execute("INSERT INTO temp_employee (shift_id, freelancer_id, restaurant_id,"
                            " valid_from, valid_until) VALUES (?,?,?,?,?)",
                            (shift_id, freelancer_id, r["id"], shift["start_time"], shift["end_time"]))
            # Sofortmeldung: Beschäftigungsbeginn = Schichtbeginn (Meldung vor Arbeitsaufnahme)
            payload = {
                "employer": r["name"], "employee": f["name"],
                "social_security_number": f["social_security_number"],
                "employment_start": shift["start_time"], "employment_end": shift["end_time"],
                "role": shift["role"], "hourly_rate": shift["hourly_rate"],
            }
            self.db.execute("INSERT INTO immediate_notification (shift_id, payload) VALUES (?,?)",
                            (shift_id, json.dumps(payload, ensure_ascii=False)))
            self.db.execute("INSERT INTO push_message (freelancer_id, body) VALUES (?,?)",
                            (freelancer_id, f"Bestätigt: {shift['role']} bei {r['name']}, {r['address']}, "
                                            f"{shift['start_time']}–{shift['end_time']}"))

    def cancel(self, shift_id):
        self._shift(shift_id)
        with self.db:
            self.db.execute("UPDATE shift_marketplace SET status='CANCELLED' WHERE id=?", (shift_id,))

    def complete(self, shift_id, rating=None):
        shift = self._shift(shift_id)
        if shift["status"] != "MATCHED":
            raise SwapError("Nur bestätigte Schichten können abgeschlossen werden")
        with self.db:
            self.db.execute("UPDATE shift_marketplace SET status='COMPLETED' WHERE id=?", (shift_id,))
            if rating is not None:
                if not 1 <= rating <= 5:
                    raise SwapError("Bewertung 1–5")
                self.db.execute(
                    "UPDATE freelancer_profile SET rating_score=(rating_score*rating_count+?)/(rating_count+1),"
                    " rating_count=rating_count+1 WHERE id=?", (rating, shift["matched_freelancer_id"]))

    # --- Freelancer ------------------------------------------------------
    def feed(self, freelancer_id, now=None):
        """Offene, passende Schichten (verifiziert, <=25 km, Skill-Tag), nächste zuerst."""
        f = self.db.execute("SELECT * FROM freelancer_profile WHERE id=?", (freelancer_id,)).fetchone()
        now = now or datetime.now().isoformat(timespec="minutes")
        out = []
        for s in self.db.execute("SELECT * FROM shift_marketplace WHERE status='OPEN' AND end_time>?", (now,)):
            r = self.db.execute("SELECT * FROM restaurant WHERE id=?", (s["restaurant_id"],)).fetchone()
            d = matching.is_eligible(s, r, f)
            if d is not None:
                out.append({**dict(s), "restaurant": r["name"], "distance_km": round(d, 1)})
        return sorted(out, key=lambda x: x["distance_km"])

    def swipe(self, shift_id, freelancer_id):
        """Interesse bekunden – nur wenn die Schicht im Feed des Nutzers wäre."""
        if shift_id not in {s["id"] for s in self.feed(freelancer_id)}:
            raise SwapError("Schicht nicht verfügbar für dieses Profil")
        self.db.execute("INSERT OR IGNORE INTO shift_application (shift_id, freelancer_id) VALUES (?,?)",
                        (shift_id, freelancer_id))
        self.db.commit()

    def _shift(self, shift_id):
        s = self.db.execute("SELECT * FROM shift_marketplace WHERE id=?", (shift_id,)).fetchone()
        if not s:
            raise SwapError("Schicht nicht gefunden")
        return s
