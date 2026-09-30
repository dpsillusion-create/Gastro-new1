import { describe, expect, it } from 'vitest';
import { boundingBox, haversineKm } from '../src/services/geo';

describe('geo', () => {
  it('Hamburg–Berlin ≈ 255 km', () => {
    expect(haversineKm(53.5511, 9.9937, 52.52, 13.405)).toBeGreaterThan(250);
    expect(haversineKm(53.5511, 9.9937, 52.52, 13.405)).toBeLessThan(260);
  });
  it('Distanz zu sich selbst = 0', () => expect(haversineKm(50, 8, 50, 8)).toBe(0));
  it('Bounding Box enthält alle Punkte im Radius', () => {
    const b = boundingBox(53.55, 9.99, 20);
    // Punkt ~19 km nördlich
    const lat = 53.55 + 19 / 111.2;
    expect(lat).toBeLessThan(b.maxLat);
    expect(haversineKm(53.55, 9.99, lat, 9.99)).toBeLessThan(20);
  });
});
