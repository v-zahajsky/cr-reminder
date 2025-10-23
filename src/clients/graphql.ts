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

  async query<T>(query: string, variables: Record<string, unknown>, attempt = 1): Promise<T> {
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
      await new Promise((r) => { setTimeout(r, retryAfter * 1000); });
      return this.query(query, variables, attempt + 1);
    }
    const text = await res.text();
    let json: GraphQLResponse<T> = {};
    try { 
      json = JSON.parse(text) as GraphQLResponse<T>;
    } catch {
      // Ignore parse errors, we'll handle missing data below
    }
    if (json.errors && json.errors.length) {
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
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
            latestTransferTime
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
    latestTransferTime: string | null;
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
