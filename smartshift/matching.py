"""Matchmaking: nur verifizierte Nutzer, max. 25 km, Skill-Tag passt zur Rolle."""
from .geo import MAX_RADIUS_KM, haversine_km

# Rolle -> akzeptierte Profil-Tags (klein geschrieben)
ROLE_TAGS = {
    "barkeeper": {"bar"}, "service": {"service"}, "servicekraft": {"service"},
    "koch": {"küche", "kueche"}, "küchenhilfe": {"küche", "kueche"},
    "spüler": {"küche", "kueche", "spüle"},
}


def skills_of(profile) -> set:
    return {s.strip().lower() for s in (profile["skills"] or "").split(",") if s.strip()}


def role_matches(role: str, skills: set) -> bool:
    wanted = ROLE_TAGS.get(role.strip().lower(), {role.strip().lower()})
    return bool(wanted & skills)


def is_eligible(shift, restaurant, profile, max_km: float = MAX_RADIUS_KM):
    """Gibt die Distanz in km zurück, wenn das Profil passt, sonst None."""
    if not profile["verified_status"] or profile["lat"] is None or profile["lon"] is None:
        return None
    if not role_matches(shift["role"], skills_of(profile)):
        return None
    d = haversine_km(restaurant["lat"], restaurant["lon"], profile["lat"], profile["lon"])
    return d if d <= max_km else None
