import { describe, it, expect } from 'vitest';
import { detectCountry } from '../src/phone.js';

describe('detectCountry', () => {
  it('reconoce Venezuela desde +58', () => {
    const r = detectCountry('+584242848748');
    expect(r.iso).toBe('VE');
    expect(r.name).toBe('Venezuela');
  });

  it('reconoce México desde +52', () => {
    const r = detectCountry('+525512345678');
    expect(r.iso).toBe('MX');
    expect(r.name).toBe('México');
  });

  it('reconoce Estados Unidos desde +1', () => {
    const r = detectCountry('+14155557890');
    expect(r.iso).toBe('US');
    expect(r.name).toMatch(/Estados Unidos/);
  });

  it('reconoce España desde +34', () => {
    const r = detectCountry('+34611223344');
    expect(r.iso).toBe('ES');
    expect(r.name).toBe('España');
  });

  it('reconoce Colombia desde +57', () => {
    const r = detectCountry('+573001234567');
    expect(r.iso).toBe('CO');
    expect(r.name).toBe('Colombia');
  });

  it('reconoce Perú desde +51', () => {
    const r = detectCountry('+51987654321');
    expect(r.iso).toBe('PE');
    expect(r.name).toBe('Perú');
  });

  it('devuelve campos vacíos si el teléfono no tiene prefijo válido', () => {
    expect(detectCountry('1234567')).toEqual({ iso: '', name: '' });
    expect(detectCountry('+9999999')).toEqual({ iso: '', name: '' });
  });

  it('tolera entradas vacías/nulas/undefined', () => {
    expect(detectCountry('')).toEqual({ iso: '', name: '' });
    expect(detectCountry(null)).toEqual({ iso: '', name: '' });
    expect(detectCountry(undefined)).toEqual({ iso: '', name: '' });
  });
});
