import { describe, expect,it } from 'vitest';

import { humanDuration } from '../src/utils/time.js';

describe('humanDuration', () => {
  it('formats minutes < 1h', () => {
    expect(humanDuration(17 * 60000)).toBe('17m');
  });
  it('formats hours', () => {
    expect(humanDuration(2 * 3600000 + 5 * 60000)).toBe('2h 5m');
  });
  it('formats days', () => {
    expect(humanDuration(1 * 24 * 3600000 + 3 * 3600000 + 10 * 60000)).toBe('1d 3h 10m');
  });
});
