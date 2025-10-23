import { Actor } from 'apify';
import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from '../src/runner.js';

const ZH_GQL = 'https://api.zenhub.com/graphql';
const GH_API = 'https://api.github.com';
const ZH_API = 'https://api.zenhub.com';
const SLACK_WEBHOOK = 'https://hooks.slack.com';

describe('network readonly behavior', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('GraphQL mode uses only POST with query (no mutation)', async () => {
    // Mock Actor.getInput to return GraphQL config
    vi.spyOn(Actor, 'getInput').mockResolvedValue({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      zenhubToken: 'DUMMY',
      useGraphql: true,
      workspaceIds: ['ws_1'],
      targetPipelines: ['Review', 'QA'],
      maxIssues: 10,
      strictPipelineTimestamp: false,
    });

    const calls: { url: string; method: string; body?: unknown }[] = [];

    global.fetch = vi.fn(async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url;
      const method = (init?.method || 'POST').toUpperCase();
      let body: unknown;
      if (init?.body && typeof init.body === 'string') {
        try { 
          body = JSON.parse(init.body) as unknown;
        } catch {
          // Ignore parse errors
        }
      }
      calls.push({ url, method, body });

      if (url.startsWith(ZH_GQL)) {
        // Return empty issues page
        return new Response(
          JSON.stringify({
            data: {
              workspace: {
                id: 'ws_1',
                name: 'WS',
                issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Mock Slack webhook - return success
      if (url.startsWith(SLACK_WEBHOOK)) {
        return new Response(JSON.stringify({ ok: true }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
      // Any other URL should not be called in this scenario; return 404 if it happens
      return new Response(JSON.stringify({}), { status: 404 });
    }) as unknown as typeof global.fetch;

    await run();

    // Assert all GraphQL calls are POST with query and without mutation
    // Filter out Slack webhook calls
    const graphqlCalls = calls.filter(c => c.url.startsWith(ZH_GQL));
    expect(graphqlCalls.length).toBeGreaterThan(0);
    for (const c of graphqlCalls) {
      expect(c.method).toBe('POST');
      const bodyObj = c.body as { query?: string };
      expect(typeof bodyObj?.query).toBe('string');
      expect(bodyObj?.query?.toLowerCase()).toContain('query');
      expect(bodyObj?.query?.toLowerCase()).not.toContain('mutation');
    }
  });

  it('REST mode uses only GET requests to GitHub/ZenHub REST', async () => {
    vi.spyOn(Actor, 'getInput').mockResolvedValue({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      zenhubToken: 'DUMMY',
      useGraphql: false,
      targets: [ { repository: { owner: 'org', name: 'repo' } } ],
      targetPipelines: ['Review', 'QA'],
      maxIssues: 10,
      strictPipelineTimestamp: false,
      githubToken: 'DUMMY_GH',
    });

    const calls: { url: string; method: string }[] = [];

    global.fetch = vi.fn(async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url;
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method });

      if (url.startsWith(`${GH_API}/repos/`)) {
        // Repo lookup returns id
        return new Response(JSON.stringify({ id: 1234 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === `${ZH_API}/v2/repositories/1234/board`) {
        // Empty board
        return new Response(JSON.stringify({ pipelines: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith(`${ZH_API}/v2/repositories/1234/issues/`)) {
        // events endpoint; empty
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Mock Slack webhook - return success
      if (url.startsWith(SLACK_WEBHOOK)) {
        return new Response(JSON.stringify({ ok: true }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as unknown as typeof global.fetch;

    await run();

    // Ensure only GET methods were used for REST endpoints
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      if (c.url.startsWith(GH_API) || c.url.startsWith(ZH_API)) {
        expect(c.method).toBe('GET');
      }
    }
  });
});
