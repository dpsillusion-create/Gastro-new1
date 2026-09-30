import json
import unittest

from smartshift.schema import connect
from smartshift.service import SmartShiftService, SwapError

FUTURE = ("2099-01-01T18:00", "2099-01-02T02:00")


class Base(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.svc = SmartShiftService(self.db)
        self.db.execute("INSERT INTO restaurant VALUES (1,'Zum Anker','Hafenstr. 1',53.55,9.99)")
        # nah/Bar/verifiziert; weit weg; unverifiziert; falscher Skill
        rows = [(1, 1, "Anna", "Bar", 1, "12345678A123", 53.56, 10.00),
                (2, 2, "Weit", "Bar", 1, "x", 52.52, 13.40),
                (3, 3, "Unver", "Bar", 0, "x", 53.56, 10.00),
                (4, 4, "Koch", "Küche", 1, "x", 53.56, 10.00),
                (5, 5, "Ben", "Bar", 1, "99999999B999", 53.54, 9.98)]
        for i, u, n, sk, v, ssn, la, lo in rows:
            self.db.execute("INSERT INTO freelancer_profile (id,user_id,name,skills,verified_status,"
                            "social_security_number,lat,lon) VALUES (?,?,?,?,?,?,?,?)",
                            (i, u, n, sk, v, ssn, la, lo))
        self.shift = self.svc.publish_shift(1, "Barkeeper", 19, *FUTURE, "Cocktailbar-Erfahrung")


class TestMatching(Base):
    def test_feed_filters(self):
        self.assertEqual(len(self.svc.feed(1)), 1)
        for fid in (2, 3, 4):
            self.assertEqual(self.svc.feed(fid), [], fid)

    def test_swipe_blocked_for_ineligible(self):
        with self.assertRaises(SwapError):
            self.svc.swipe(self.shift, 2)


class TestFlow(Base):
    def test_confirm_creates_temp_profile_and_sofortmeldung(self):
        self.svc.swipe(self.shift, 1)
        self.svc.swipe(self.shift, 5)
        self.svc.confirm(self.shift, 1)
        s = self.db.execute("SELECT * FROM shift_marketplace").fetchone()
        self.assertEqual((s["status"], s["matched_freelancer_id"]), ("MATCHED", 1))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM temp_employee").fetchone()[0], 1)
        p = json.loads(self.db.execute("SELECT payload FROM immediate_notification").fetchone()[0])
        self.assertEqual(p["social_security_number"], "12345678A123")
        self.assertEqual(self.db.execute("SELECT status FROM shift_application WHERE freelancer_id=5")
                         .fetchone()[0], "REJECTED")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM push_message").fetchone()[0], 1)
        with self.assertRaises(SwapError):
            self.svc.confirm(self.shift, 5)

    def test_confirm_requires_ssn(self):
        self.db.execute("UPDATE freelancer_profile SET social_security_number=NULL WHERE id=1")
        self.svc.swipe(self.shift, 1)
        with self.assertRaises(SwapError):
            self.svc.confirm(self.shift, 1)

    def test_complete_and_rating(self):
        self.svc.swipe(self.shift, 1)
        self.svc.confirm(self.shift, 1)
        self.svc.complete(self.shift, rating=5)
        self.assertEqual(self.db.execute("SELECT rating_score FROM freelancer_profile WHERE id=1")
                         .fetchone()[0], 5)

    def test_validation(self):
        with self.assertRaises(SwapError):
            self.svc.publish_shift(1, "Koch", 15, FUTURE[1], FUTURE[0])


if __name__ == "__main__":
    unittest.main()
