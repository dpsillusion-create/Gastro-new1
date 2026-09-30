import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS restaurant (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
    lat REAL NOT NULL, lon REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS freelancer_profile (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE, name TEXT NOT NULL,
    skills TEXT NOT NULL DEFAULT '',            -- kommagetrennte Tags, z. B. "Bar,Küche"
    rating_score REAL NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0,
    verified_status INTEGER NOT NULL DEFAULT 0 CHECK (verified_status IN (0,1)),
    social_security_number TEXT,                -- sensibel: nur für die Sofortmeldung
    lat REAL, lon REAL
);
CREATE TABLE IF NOT EXISTS shift_marketplace (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurant(id),
    role TEXT NOT NULL, hourly_rate REAL NOT NULL CHECK (hourly_rate > 0),
    start_time TEXT NOT NULL, end_time TEXT NOT NULL,   -- ISO 8601
    requirements TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN','MATCHED','COMPLETED','CANCELLED')),
    matched_freelancer_id INTEGER REFERENCES freelancer_profile(id)
);
CREATE TABLE IF NOT EXISTS shift_application (
    id INTEGER PRIMARY KEY,
    shift_id INTEGER NOT NULL REFERENCES shift_marketplace(id),
    freelancer_id INTEGER NOT NULL REFERENCES freelancer_profile(id),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','CONFIRMED','REJECTED')),
    UNIQUE (shift_id, freelancer_id)
);
CREATE TABLE IF NOT EXISTS temp_employee (       -- temporäres Profil für Zeiterfassung/Dienstplan
    id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL UNIQUE,
    freelancer_id INTEGER NOT NULL, restaurant_id INTEGER NOT NULL,
    valid_from TEXT NOT NULL, valid_until TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS immediate_notification ( -- Sofortmeldung (Datensatz zur Übermittlung)
    id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','SENT'))
);
CREATE TABLE IF NOT EXISTS push_message (
    id INTEGER PRIMARY KEY, freelancer_id INTEGER NOT NULL, body TEXT NOT NULL
);
"""


def connect(path: str = ":memory:") -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn
