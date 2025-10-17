import { describe, it, expect } from 'vitest';
import { updateState } from '../src/storage/state.js';
import { PersistedState, IssuePipelineSnapshot, CURRENT_STATE_SCHEMA_VERSION } from '../src/types.js';

describe('updateState', () => {
  it('adds snapshot and updates lastRun', () => {
    const prev: PersistedState = { issues: {}, lastRun: null, schemaVersion: CURRENT_STATE_SCHEMA_VERSION };
    const snap: IssuePipelineSnapshot = {
      issueNumber: 1,
      repo: { owner: 'o', name: 'r' },
      title: 'Test',
      assignees: [],
      pipeline: 'Review',
      pipelineEnteredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const next = updateState(prev, [snap]);
    expect(Object.keys(next.issues).length).toBe(1);
    expect(next.lastRun).not.toBeNull();
  });
});
