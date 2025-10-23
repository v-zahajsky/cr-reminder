import { describe, it, expect, beforeEach, vi } from 'vitest';
import { run } from '../src/runner.js';

describe('sendEmptyReport behavior', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  
  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  it('should NOT send Slack message when sendEmptyReport is false and no issues', async () => {
    const SLACK_WEBHOOK = 'https://hooks.slack.com/test';
    const GRAPHQL_ENDPOINT = 'https://api.zenhub.com/public/graphql';
    
    fetchMock.mockImplementation(async (url: string) => {
      // GraphQL query - return empty workspace
      if (url === GRAPHQL_ENDPOINT) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              workspace: {
                id: 'ws_1',
                name: 'WS',
                issues: {
                  pageInfo: { hasNextPage: false },
                  nodes: []
                }
              }
            }
          }),
          text: async () => 'ok',
        };
      }
      
      throw new Error(`Unexpected fetch to ${url}`);
    });

    // Mock Actor methods
    const mockActor = {
      init: vi.fn(),
      getInput: vi.fn().mockResolvedValue({
        useGraphql: true,
        graphqlEndpoint: GRAPHQL_ENDPOINT,
        workspaceIds: ['ws_1'],
        targetPipelines: ['Review/QA'],
        zenhubToken: 'token',
        slackWebhookUrl: SLACK_WEBHOOK,
        sendEmptyReport: false, // KEY: set to false
      }),
      pushData: vi.fn(),
      exit: vi.fn(),
      setValue: vi.fn(),
      getValue: vi.fn().mockResolvedValue(null),
    };
    
    vi.doMock('apify', () => ({ 
      Actor: mockActor,
      log: {
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }
    }));

    await run();
    
    // Verify Slack webhook was NOT called
    const slackCalls = fetchMock.mock.calls.filter(call => call[0] === SLACK_WEBHOOK);
    expect(slackCalls.length).toBe(0);
  });

  it('should send Slack message when sendEmptyReport is true and no issues', async () => {
    const SLACK_WEBHOOK = 'https://hooks.slack.com/test';
    const GRAPHQL_ENDPOINT = 'https://api.zenhub.com/public/graphql';
    
    fetchMock.mockImplementation(async (url: string) => {
      // GraphQL query - return empty workspace
      if (url === GRAPHQL_ENDPOINT) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              workspace: {
                id: 'ws_1',
                name: 'WS',
                issues: {
                  pageInfo: { hasNextPage: false },
                  nodes: []
                }
              }
            }
          }),
          text: async () => 'ok',
        };
      }
      
      // Slack webhook
      if (url === SLACK_WEBHOOK) {
        return {
          ok: true,
          status: 200,
          text: async () => 'ok',
        };
      }
      
      throw new Error(`Unexpected fetch to ${url}`);
    });

    // Mock Actor methods
    const mockActor = {
      init: vi.fn(),
      getInput: vi.fn().mockResolvedValue({
        useGraphql: true,
        graphqlEndpoint: GRAPHQL_ENDPOINT,
        workspaceIds: ['ws_1'],
        targetPipelines: ['Review/QA'],
        zenhubToken: 'token',
        slackWebhookUrl: SLACK_WEBHOOK,
        sendEmptyReport: true, // KEY: set to true
      }),
      pushData: vi.fn(),
      exit: vi.fn(),
      setValue: vi.fn(),
      getValue: vi.fn().mockResolvedValue(null),
    };
    
    vi.doMock('apify', () => ({ 
      Actor: mockActor,
      log: {
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }
    }));

    await run();
    
    // Verify Slack webhook WAS called
    const slackCalls = fetchMock.mock.calls.filter(call => call[0] === SLACK_WEBHOOK);
    expect(slackCalls.length).toBe(1);
    
    // Verify message content
    const slackPayload = JSON.parse(slackCalls[0][1]?.body as string);
    expect(slackPayload.text).toContain('Great work');
  });
});
