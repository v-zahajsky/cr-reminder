export type RepoRef = { owner: string; name: string };

export interface TargetConfig {
  repository: RepoRef;
  repoId?: number; // optional GitHub repository ID (can speed some ZenHub calls)
}

export interface InputSchema {
	slackWebhookUrl: string;
	zenhubToken: string;
	useGraphql?: boolean;
	graphqlEndpoint?: string;
	workspaceIds?: string[];
	targetPipelines: string[];
	maxIssues?: number;
	sendEmptyReport?: boolean;
}

export interface IssuePipelineSnapshot {
  issueNumber: number;
  repo: RepoRef;
  title: string;
  assignees: string[];
  pipeline: string;
  pipelineEnteredAt: string; // ISO
  updatedAt: string; // ISO last seen
  type: string; // e.g. 'GithubIssue', 'ZenhubIssue'
  state: string; // e.g. 'OPEN', 'CLOSED'
  createdAt: string; // ISO when created
  isPullRequest: boolean; // true if it's a Pull Request
  isDraft?: boolean; // true if it's a draft PR (only for pull requests)
}

export interface IssueDurationRecord extends IssuePipelineSnapshot {
  durationMs: number;
  durationMinutes: number;
  durationHours: number;
  durationHuman: string; // e.g. '2d 3h 15m'
  assigneesCount: number;
  assigneesDisplay: string; // e.g. 'user1, user2' or 'Unassigned'
  typeDisplay: string; // e.g. 'Issue', 'Pull Request', or 'Draft Pull Request'
  isPullRequest: boolean;
  isDraft?: boolean;
  draftDisplay: string; // e.g. 'Draft' or 'Ready' (for PRs only)
  githubUrl: string; // Direct link to GitHub issue/PR
}

export interface PersistedState {
  issues: Record<string, IssuePipelineSnapshot>; // key: `${owner}/${name}#${issueNumber}`
  lastRun: string | null;
  schemaVersion: 1;
}

export const CURRENT_STATE_SCHEMA_VERSION = 1 as const;

export function makeIssueKey(repo: RepoRef, issueNumber: number): string {
  return `${repo.owner}/${repo.name}#${issueNumber}`;
}
