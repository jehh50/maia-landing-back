import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Cache global del traductor (perf — no es necesario reconstruirlo por llamada).
const regionNames = new Intl.DisplayNames(['es'], { type: 'region' });

/**
 * Extrae el país de un teléfono en formato E.164 (`+<country><number>`).
 * Devuelve siempre un objeto, con cadenas vacías si no se pudo determinar.
 *
 * @param {string} phone - Teléfono normalizado (idealmente con prefijo `+`).
 * @returns {{ iso: string, name: string }}
 *   iso : código ISO 3166-1 alpha-2 (`"VE"`, `"MX"`, ...). Vacío si no se reconoce.
 *   name: nombre del país en español (`"Venezuela"`, `"México"`, ...). Vacío si no se reconoce.
 */
export function detectCountry(phone) {
  if (!phone || typeof phone !== 'string') return { iso: '', name: '' };
  try {
    const parsed = parsePhoneNumberFromString(phone);
    const iso = parsed?.country ?? '';
    const name = iso ? (regionNames.of(iso) || '') : '';
    return { iso, name };
  } catch {
    return { iso: '', name: '' };
  }
}
