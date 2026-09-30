function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return v;
}
export const config = {
  port: Number(process.env.PORT ?? 3000),
  get jwtSecret() { return required('JWT_SECRET'); },
  get ssnKey() {
    const key = Buffer.from(required('SSN_ENCRYPTION_KEY'), 'base64');
    if (key.length !== 32) throw new Error('SSN_ENCRYPTION_KEY muss 32 Byte (base64) sein');
    return key;
  },
};
/** Maximaler Suchradius (km) – Produktvorgabe. */
export const MAX_RADIUS_KM = 25;
export const DEFAULT_RADIUS_KM = 20;
