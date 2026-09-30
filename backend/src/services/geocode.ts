import { badRequest } from '../errors';

/** Adresse → Koordinaten über OpenStreetMap Nominatim (max. 1 Anfrage/s laut Nutzungsrichtlinie; nur bei Registrierung). */
export async function geocodeAddress(street: string | undefined, zip: string, city: string) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'de', ...(street ? { street } : {}), postalcode: zip, city }).toString();
  let data: Array<{ lat: string; lon: string }>;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'GastroEvolution-SmartShift/1.0 (jobs.gastroevolution.de)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(String(res.status));
    data = (await res.json()) as typeof data;
  } catch {
    throw badRequest('Adresse konnte gerade nicht geprüft werden – bitte später erneut versuchen');
  }
  const hit = data[0];
  if (!hit) throw badRequest('Adresse nicht gefunden – bitte Straße, PLZ und Ort prüfen');
  return { latitude: Number(hit.lat), longitude: Number(hit.lon) };
}
