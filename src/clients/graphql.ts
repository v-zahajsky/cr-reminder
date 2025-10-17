import { log } from 'apify';

export interface GraphQLClientOptions {
  endpoint: string; // e.g. https://api.zenhub.com/public/graphql or similar
  token: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export class GraphQLClient {
  constructor(private opts: GraphQLClientOptions) {}

  async query<T>(query: string, variables: Record<string, any>, attempt = 1): Promise<T> {
    const res = await fetch(this.opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get('Retry-After')) || attempt * 2;
      log.warning(`GraphQL rate limited, retry in ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.query(query, variables, attempt + 1);
    }
    let text = await res.text();
    let json: GraphQLResponse<T> = {};
    try { json = JSON.parse(text) as GraphQLResponse<T>; } catch {}
    if (json.errors && json.errors.length) {
      throw new Error('GraphQL errors: ' + json.errors.map((e) => e.message).join('; '));
    }
    if (!json.data) throw new Error(`GraphQL response missing data (status ${res.status}): ${text.slice(0, 200)}`);
    return json.data;
  }
}

// Based on official ZenHub GraphQL API documentation
export const WORKSPACE_ISSUES_QUERY = `
  query WorkspaceIssues($workspaceId: ID!, $after: String) {
    workspace(id: $workspaceId) {
      id
      name
      issues(first: 50, after: $after) {
        pageInfo { 
          hasNextPage 
          endCursor 
        }
        nodes {
          id
          number
          title
          type
          state
          createdAt
          updatedAt
          pullRequest
          repository {
            id
            ghId
            name
            owner {
              login
            }
          }
          assignees {
            nodes {
              ghId
              login
            }
          }
          pipelineIssue(workspaceId: $workspaceId) {
            pipeline {
              id
              name
            }
          }
        }
      }
    }
  }
`;

export const ISSUE_TIMELINE_QUERY = `
  query IssueTimeline($repositoryGhId: Int!, $issueNumber: Int!) {
    issueByInfo(repositoryGhId: $repositoryGhId, issueNumber: $issueNumber) {
      id
      number
      title
      transferEvents(last: 50) {
        nodes {
          id
          createdAt
          toPipeline {
            id
            name
          }
          fromPipeline {
            id
            name
          }
        }
      }
    }
  }
`;

export interface WorkspaceIssueNode {
  id: string;
  number: number;
  title: string;
  type: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  pullRequest: boolean;
  repository: {
    id: string;
    ghId: number;
    name: string;
    owner: {
      login: string;
    };
  };
  assignees: { 
    nodes: { 
      ghId: string; 
      login: string 
    }[] 
  };
  pipelineIssue: {
    pipeline: {
      id: string;
      name: string;
    };
  } | null;
}

export interface WorkspaceIssuesResult {
  workspace: {
    id: string;
    name: string;
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor?: string };
      nodes: WorkspaceIssueNode[];
    };
  } | null;
}

export interface IssueTimelineResult {
  issueByInfo: {
    id: string;
    number: number;
    title: string;
    transferEvents: {
      nodes: {
        id: string;
        createdAt: string;
        toPipeline: {
          id: string;
          name: string;
        };
        fromPipeline: {
          id: string;
          name: string;
        } | null;
      }[];
    };
  } | null;
}

export function extractPipelineEnteredAtFromTimeline(events: any[], targetPipeline: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const toName = ev?.toPipeline?.name;
    if (toName === targetPipeline && ev.createdAt) {
      return ev.createdAt;
    }
  }
  return undefined;
}

export function extractCurrentPipelineFromTimeline(events: any[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.toPipeline?.name) {
      return ev.toPipeline.name;
    }
  }
  return undefined;
}
