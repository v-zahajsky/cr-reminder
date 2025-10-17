import { describe, it, expect } from 'vitest';
import { ZenHubClient } from '../src/clients/zenhub.js';

describe('ZenHubClient.extractPipelineEnteredAt', () => {
  const client = new ZenHubClient({ token: 'x' });
  it('finds last transfer into target pipeline', () => {
    const events = [
      { type: 'transferIssue', toPipeline: { name: 'Backlog' }, createdAt: '2025-01-01T00:00:00Z' },
      { type: 'transferIssue', toPipeline: { name: 'Review' }, createdAt: '2025-01-02T00:00:00Z' },
      { type: 'transferIssue', toPipeline: { name: 'QA' }, createdAt: '2025-01-03T00:00:00Z' },
      { type: 'transferIssue', toPipeline: { name: 'Review' }, createdAt: '2025-01-04T10:00:00Z' },
    ];
    const ts = client.extractPipelineEnteredAt(events, 'Review');
    expect(ts).toBe('2025-01-04T10:00:00Z');
  });

  it('returns undefined when no event for target pipeline', () => {
    const events = [{ type: 'transferIssue', toPipeline: { name: 'Backlog' }, createdAt: '2025-01-01T00:00:00Z' }];
    const ts = client.extractPipelineEnteredAt(events, 'Review');
    expect(ts).toBeUndefined();
  });
});
