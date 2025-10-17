import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { run } from '../src/runner.js';
import { Actor } from 'apify';

const ZH_GQL = 'https://api.zenhub.com/graphql';
const GH_API = 'https://api.github.com';
const ZH_API = 'https://api.zenhub.com';

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
      zenhubToken: 'DUMMY',
      useGraphql: true,
      workspaceIds: ['ws_1'],
      targetPipelines: ['Review', 'QA'],
      maxIssues: 10,
      strictPipelineTimestamp: false,
    });

    const calls: Array<{ url: string; method: string; body?: any }> = [];

    global.fetch = vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url;
      const method = (init?.method || 'POST').toUpperCase();
      let body: any = undefined;
      if (init?.body && typeof init.body === 'string') {
        try { body = JSON.parse(init.body); } catch {}
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
      // Any other URL should not be called in this scenario; return 404 if it happens
      return new Response(JSON.stringify({}), { status: 404 });
    }) as any;

    await run();

    // Assert all calls are POST to GraphQL with query and without mutation
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.startsWith(ZH_GQL)).toBe(true);
      expect(c.method).toBe('POST');
      expect(typeof c.body?.query).toBe('string');
      expect(c.body?.query.toLowerCase()).toContain('query');
      expect(c.body?.query.toLowerCase()).not.toContain('mutation');
    }
  });

  it('REST mode uses only GET requests to GitHub/ZenHub REST', async () => {
    vi.spyOn(Actor, 'getInput').mockResolvedValue({
      zenhubToken: 'DUMMY',
      useGraphql: false,
      targets: [ { repository: { owner: 'org', name: 'repo' } } ],
      targetPipelines: ['Review', 'QA'],
      maxIssues: 10,
      strictPipelineTimestamp: false,
      githubToken: 'DUMMY_GH',
    });

    const calls: Array<{ url: string; method: string; body?: any }> = [];

    global.fetch = vi.fn(async (input: any, init?: RequestInit) => {
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
      return new Response(JSON.stringify({}), { status: 404 });
    }) as any;

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
