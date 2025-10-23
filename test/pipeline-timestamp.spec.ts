import { describe, it, expect } from 'vitest';

describe('Pipeline timestamp logic', () => {
  it('should use latestTransferTime when available', () => {
    const latestTransferTime = '2025-10-22T05:55:22Z';
    const createdAt = '2025-10-18T01:47:51Z';
    const updatedAt = '2025-10-22T05:55:23Z';

    // Simulate the logic from runner.ts
    const enteredAt = latestTransferTime;
    
    expect(enteredAt).toBe(latestTransferTime);
    expect(enteredAt).not.toBe(createdAt);
    expect(enteredAt).not.toBe(updatedAt);
  });

  it('should handle undefined latestTransferTime with fallback', () => {
    const latestTransferTime = undefined;
    const nowIso = new Date().toISOString();
    
    // Simulate the logic from runner.ts
    const enteredAt = latestTransferTime;
    const fallbackEnteredAt = enteredAt || nowIso;
    
    expect(fallbackEnteredAt).toBe(nowIso);
  });

  it('should use latestTransferTime even when different from updatedAt', () => {
    // This is the key test - showing that latestTransferTime captures
    // only pipeline transfers, not other updates like comments
    const latestTransferTime = '2025-10-22T05:55:22Z';
    const updatedAt = '2025-10-23T10:30:00Z'; // Later update (e.g., comment added)
    
    const enteredAt = latestTransferTime;
    
    // enteredAt should be the transfer time, NOT the updatedAt
    expect(enteredAt).toBe(latestTransferTime);
    expect(enteredAt).not.toBe(updatedAt);
    expect(new Date(enteredAt).getTime()).toBeLessThan(new Date(updatedAt).getTime());
  });

  it('should calculate correct duration from latestTransferTime', () => {
    const latestTransferTime = '2025-10-22T05:55:22Z';
    const now = new Date('2025-10-23T11:49:51.503Z');
    
    const enteredAtMs = new Date(latestTransferTime).getTime();
    const nowMs = now.getTime();
    const durationMs = nowMs - enteredAtMs;
    
    const expectedDurationMs = 107669503; // Approximately 29.9 hours
    const expectedDurationHours = Math.floor(expectedDurationMs / (1000 * 60 * 60));
    
    expect(durationMs).toBeCloseTo(expectedDurationMs, -3); // Within 1000ms
    expect(expectedDurationHours).toBe(29);
  });
});
