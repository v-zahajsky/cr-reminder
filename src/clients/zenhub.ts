// Placeholder ZenHub client. Will be expanded to real HTTP calls.
import { log } from 'apify';

import type { IssuePipelineSnapshot,RepoRef } from '../types.js';

// ZenHub public API base (v2). Adjust if different.
// ZenHub REST API base; documentation suggests versions like /v2; adjust when necessary.
const ZENHUB_API_BASE = 'https://api.zenhub.com';

export interface ZenHubIssueRaw {
  issueNumber: number;
  title: string;
  assignees: string[]; // GitHub usernames
  pipeline: string;
  // If API provides timestamp when entered pipeline, include it here
  pipelineEnteredAt?: string; // ISO
}

export interface ZenHubClientOptions {
  token: string;
}

export class ZenHubClient {
  constructor(private opts: ZenHubClientOptions) {}

  private async request<T>(path: string, init: RequestInit = {}, attempt = 1): Promise<T> {
    const res = await fetch(`${ZENHUB_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get('Retry-After')) || attempt * 2;
      log.warning(`ZenHub rate limited (attempt ${attempt}), sleeping ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.request<T>(path, init, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ZenHub API ${path} failed ${res.status}: ${text}`);
    }
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  // We attempt to fetch board (pipelines + issues). Without workspace context, using repository board.
  // Example (hypothetical): /v2/repositories/{repo_id}/board
  async listBoard(repoId: number): Promise<any> {
    return this.request(`/v2/repositories/${repoId}/board`);
  }

  // Issues events for pipeline history
  async listIssueEvents(repoId: number, issueNumber: number): Promise<any[]> {
    return this.request(`/v2/repositories/${repoId}/issues/${issueNumber}/events`);
  }

  // Convert board response to ZenHubIssueRaw[]
  extractIssuesFromBoard(board: any): ZenHubIssueRaw[] {
    if (!board || !Array.isArray(board.pipelines)) return [];
    const issues: ZenHubIssueRaw[] = [];
    for (const pipe of board.pipelines) {
      if (!Array.isArray(pipe.issues)) continue;
      for (const iss of pipe.issues) {
        // pipeline name from pipe.name
        issues.push({
          issueNumber: iss.number ?? iss.issue_number ?? iss.githubIssue?.number,
          title: iss.title ?? iss.githubIssue?.title ?? 'Unknown',
          assignees: (iss.assignees || iss.githubIssue?.assignees || []).map((a: any) => a.login || a.username || a),
          pipeline: pipe.name,
        });
      }
    }
    return issues.filter((i) => typeof i.issueNumber === 'number');
  }

  extractPipelineEnteredAt(events: any[], targetPipeline: string): string | undefined {
    // Search chronological events for last transfer into target pipeline.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const toName = ev?.toPipeline?.name || ev?.to_pipeline?.name || ev?.pipeline?.name;
      if (
        (ev.type === 'transferIssue' || ev.type === 'pipeline:transfer' || ev.event_type === 'transferIssue') &&
        toName === targetPipeline &&
        (ev.createdAt || ev.created_at)
      ) {
        return ev.createdAt || ev.created_at;
      }
    }
    return undefined;
  }

  async listIssuesInRepoUsingBoard(repo: RepoRef, repoId?: number): Promise<ZenHubIssueRaw[]> {
    if (!repoId) {
      log.warning(`Missing repoId for ${repo.owner}/${repo.name}; returning empty issue list.`);
      return [];
    }
    const board = await this.listBoard(repoId);
    return this.extractIssuesFromBoard(board);
  }
}

export function mapRawToSnapshot(
  repo: RepoRef,
  raw: ZenHubIssueRaw,
  nowIso: string,
  fallbackEnteredAt: string,
): IssuePipelineSnapshot {
  return {
    issueNumber: raw.issueNumber,
    repo,
    title: raw.title,
    assignees: raw.assignees,
    pipeline: raw.pipeline,
    pipelineEnteredAt: raw.pipelineEnteredAt ?? fallbackEnteredAt,
    updatedAt: nowIso,
    type: 'ZenhubIssue', // Default type for REST API
    state: 'OPEN', // Default state for REST API
    createdAt: nowIso, // Fallback - not available in REST API
    isPullRequest: false, // Default - REST API doesn't distinguish
    isDraft: undefined, // Not available in REST API
  };
}
