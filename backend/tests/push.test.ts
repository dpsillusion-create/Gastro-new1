import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedPushEndpoint } from '../src/services/push';

afterEach(() => { delete process.env.PUSH_ALLOW_ANY; delete process.env.PUSH_EXTRA_HOSTS; });

describe('erlaubte Push-Dienste (SSRF-Schutz)', () => {
  it('akzeptiert die Dienste der großen Browser', () => {
    for (const u of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Q123', 'https://wns2-par02p.notify.windows.com/?token=1'])
      expect(isAllowedPushEndpoint(u), u).toBe(true);
  });
  it('lehnt interne, lokale und fremde Ziele ab', () => {
    for (const u of ['https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x', 'https://[::1]/x', 'http://fcm.googleapis.com/x',
      'https://evil.example.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'nicht-einmal-eine-url'])
      expect(isAllowedPushEndpoint(u), u).toBe(false);
  });
  it('zusätzliche Hosts nur per Einstellung', () => {
    expect(isAllowedPushEndpoint('https://push.meinefirma.de/x')).toBe(false);
    process.env.PUSH_EXTRA_HOSTS = 'push.meinefirma.de';
    expect(isAllowedPushEndpoint('https://push.meinefirma.de/x')).toBe(true);
  });
  it('PUSH_ALLOW_ANY wirkt in Produktion nicht', () => {
    process.env.PUSH_ALLOW_ANY = '1';
    const old = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    expect(isAllowedPushEndpoint('https://localhost/x')).toBe(false);
    process.env.NODE_ENV = old;
  });
});
