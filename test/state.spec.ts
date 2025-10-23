import { describe, expect, it } from 'vitest';

import type { IssuePipelineSnapshot, PersistedState } from '../src/types.js';
import { CURRENT_STATE_SCHEMA_VERSION } from '../src/types.js';

// Helper function for testing (state management not yet implemented in main code)
function updateState(prev: PersistedState, snapshots: IssuePipelineSnapshot[]): PersistedState {
  const next: PersistedState = { ...prev, issues: { ...prev.issues }, lastRun: new Date().toISOString() };
  for (const snap of snapshots) {
    const key = `${snap.repo.owner}/${snap.repo.name}#${snap.issueNumber}`;
    next.issues[key] = snap;
  }
  return next;
}

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
      type: 'GithubIssue',
      state: 'OPEN',
      createdAt: new Date().toISOString(),
      isPullRequest: false,
    };
    const next = updateState(prev, [snap]);
    expect(Object.keys(next.issues).length).toBe(1);
    expect(next.lastRun).not.toBeNull();
  });
});
