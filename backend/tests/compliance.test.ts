import { describe, expect, it } from 'vitest';
import { validateBirthDate, validateSocialSecurityNumber, validateTaxId } from '../src/services/compliance';
import { applyNoShowPenalty } from '../src/services/reliability';

describe('Steuer-ID', () => {
  it('akzeptiert gültige Prüfziffer', () => expect(validateTaxId('86095742719')).toBe(true));
  it('lehnt falsche Prüfziffer/Format ab', () => {
    expect(validateTaxId('86095742718')).toBe(false);
    expect(validateTaxId('06095742719')).toBe(false);
    expect(validateTaxId('123')).toBe(false);
  });
});

describe('SV-Nummer', () => {
  it('akzeptiert gültige Nummer (Beispiel DRV)', () => expect(validateSocialSecurityNumber('15070649C103')).toBe(true));
  it('prüft Geburtsdatum-Abgleich', () => {
    expect(validateSocialSecurityNumber('15070649C103', new Date(Date.UTC(1949, 5, 7)))).toBe(true);
    expect(validateSocialSecurityNumber('15070649C103', new Date(Date.UTC(1990, 0, 1)))).toBe(false);
  });
  it('lehnt falsche Prüfziffer ab', () => expect(validateSocialSecurityNumber('15070649C104')).toBe(false));
});

describe('Geburtsdatum', () => {
  it('Mindestalter 16', () => {
    expect(validateBirthDate(new Date(Date.UTC(2000, 0, 1)))).toBe(true);
    expect(validateBirthDate(new Date())).toBe(false);
  });
});

describe('Reliability', () => {
  it('ein No-Show senkt drastisch und sperrt (<0.90)', () => {
    expect(applyNoShowPenalty(1.0)).toEqual({ score: 0.75, suspend: true });
  });
  it('Score nie unter 0', () => expect(applyNoShowPenalty(0.1).score).toBe(0));
});
