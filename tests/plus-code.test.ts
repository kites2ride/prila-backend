import { describe, expect, it } from 'vitest';
import { stripLeadingPlusCode } from '../src/modules/maps/google.js';

describe('stripLeadingPlusCode', () => {
  it('removes a leading plus code', () => {
    expect(stripLeadingPlusCode('6C29+C67, Ranganayakula Gutta Rd, Karimnagar, Telangana 505498, India')).toBe(
      'Ranganayakula Gutta Rd, Karimnagar, Telangana 505498, India',
    );
  });
  it('removes a short plus code followed by a locality', () => {
    expect(stripLeadingPlusCode('692V+94P Huzurabad, Telangana, India')).toBe('Huzurabad, Telangana, India');
  });
  it('returns empty for a code-only address', () => {
    expect(stripLeadingPlusCode('692V+94P')).toBe('');
  });
  it('leaves normal addresses alone', () => {
    expect(stripLeadingPlusCode('Bus stand, Chandrayangutta Road, Hyderabad')).toBe('Bus stand, Chandrayangutta Road, Hyderabad');
  });
});
