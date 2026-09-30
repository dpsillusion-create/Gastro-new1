/** Fachliche Fehler mit HTTP-Status; werden im Error-Handler in einheitliche JSON-Antworten übersetzt. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export const badRequest = (m: string) => new HttpError(400, 'BAD_REQUEST', m);
export const unauthorized = (m = 'Nicht authentifiziert') => new HttpError(401, 'UNAUTHORIZED', m);
export const forbidden = (m = 'Kein Zugriff') => new HttpError(403, 'FORBIDDEN', m);
export const notFound = (m = 'Nicht gefunden') => new HttpError(404, 'NOT_FOUND', m);
export const conflict = (m: string) => new HttpError(409, 'CONFLICT', m);
/** Falsches Passwort bei einer Bestätigung eingeloggter Nutzer – bewusst anderer Code als UNAUTHORIZED, damit die Oberfläche nicht abmeldet. */
export const wrongPassword = () => new HttpError(401, 'WRONG_PASSWORD', 'Passwort falsch');
