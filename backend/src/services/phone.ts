/** Normalisiert Handynummern nach E.164. Nummern ohne Ländervorwahl werden als deutsch (+49) gelesen. */
export function normalizePhone(raw: string): string | null {
  let s = raw.replace(/[\s()./-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (s.startsWith('0')) s = '+49' + s.slice(1);
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
