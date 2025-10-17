import { RepoRef } from '../types.js';
import { log } from 'apify';

const GITHUB_API_BASE = 'https://api.github.com';

export interface GitHubClientOptions {
  token?: string;
}

export class GitHubClient {
  constructor(private opts: GitHubClientOptions) {}

  private headers(): Record<string, string> {
    return {
      'User-Agent': 'cr-reminder-actor',
      Accept: 'application/vnd.github+json',
      ...(this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {}),
    };
  }

  private async request<T>(path: string, attempt = 1): Promise<T> {
    const res = await fetch(`${GITHUB_API_BASE}${path}`, { headers: this.headers() });
    if (res.status === 429 || res.status === 403) {
      const ratelimitReset = res.headers.get('x-ratelimit-reset');
      if (attempt < 3 && ratelimitReset) {
        const wait = Math.min(30, parseInt(ratelimitReset, 10) * 1000 - Date.now());
        log.warning(`GitHub rate limit; waiting ${wait}ms`);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        return this.request<T>(path, attempt + 1);
      }
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GitHub API ${path} failed ${res.status}: ${txt}`);
    }
    return (await res.json()) as T;
  }

  async getRepo(repo: RepoRef): Promise<{ id: number }> {
    return this.request(`/repos/${repo.owner}/${repo.name}`);
  }

  async getPullRequest(repo: RepoRef, prNumber: number): Promise<{ draft: boolean; state: string } | null> {
    try {
      return this.request(`/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`);
    } catch (error) {
      log.warning(`Failed to get PR details for #${prNumber}: ${(error as Error).message}`);
      return null;
    }
  }
}
