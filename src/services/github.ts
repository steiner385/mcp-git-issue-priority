import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';
import type { Issue, Label, IssuePriority, IssueType, PrStatus, CheckStatus } from '../models/index.js';
import { LABEL_DEFINITIONS } from '../models/index.js';

const ThrottledOctokit = Octokit.plugin(throttling, retry);

export interface IssueParent {
  number: number;
  state: 'open' | 'closed';
}

export interface CreateIssueParams {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  priority: IssuePriority;
  type: IssueType;
}

export interface GitHubServiceOptions {
  token: string;
}

export class GitHubService {
  private octokit: InstanceType<typeof ThrottledOctokit>;

  constructor(options: GitHubServiceOptions) {
    this.octokit = new ThrottledOctokit({
      auth: options.token,
      throttle: {
        onRateLimit: (retryAfter, options, _octokit, retryCount) => {
          const opts = options as { method: string; url: string };
          console.error(
            `Rate limit hit for ${opts.method} ${opts.url}. Retry ${retryCount + 1}`
          );
          return retryCount < 2;
        },
        onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
          const opts = options as { method: string; url: string };
          console.error(
            `Secondary rate limit hit for ${opts.method} ${opts.url}. Retry ${retryCount + 1}`
          );
          return retryCount < 1;
        },
      },
      retry: {
        doNotRetry: [400, 401, 403, 404, 422],
        retries: 3,
      },
    });
  }

  async ensureLabelsExist(owner: string, repo: string): Promise<void> {
    const allLabels = {
      ...LABEL_DEFINITIONS.priority,
      ...LABEL_DEFINITIONS.type,
      ...LABEL_DEFINITIONS.status,
    };

    for (const [name, definition] of Object.entries(allLabels)) {
      try {
        await this.octokit.issues.getLabel({ owner, repo, name });
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          await this.octokit.issues.createLabel({
            owner,
            repo,
            name,
            color: definition.color,
            description: definition.description,
          });
        } else {
          throw error;
        }
      }
    }
  }

  async createIssue(params: CreateIssueParams): Promise<Issue> {
    const { owner, repo, title, body, priority, type } = params;

    await this.ensureLabelsExist(owner, repo);

    const labels = [`priority:${priority}`, `type:${type}`, 'status:backlog'];

    const response = await this.octokit.issues.create({
      owner,
      repo,
      title,
      body: body ?? '',
      labels,
    });

    return this.mapApiIssue(response.data, owner, repo);
  }

  async listOpenIssues(owner: string, repo: string): Promise<Issue[]> {
    const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });

    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => this.mapApiIssue(issue, owner, repo));
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<Issue> {
    const response = await this.octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    return this.mapApiIssue(response.data, owner, repo);
  }

  async updateIssueLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    addLabels: string[],
    removeLabels: string[]
  ): Promise<void> {
    for (const label of removeLabels) {
      try {
        await this.octokit.issues.removeLabel({
          owner,
          repo,
          issue_number: issueNumber,
          name: label,
        });
      } catch (error) {
        if ((error as { status?: number }).status !== 404) {
          throw error;
        }
      }
    }

    if (addLabels.length > 0) {
      await this.octokit.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: addLabels,
      });
    }
  }

  async createBranch(
    owner: string,
    repo: string,
    branchName: string,
    baseBranch: string = 'main'
  ): Promise<string> {
    const baseRef = await this.octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });

    const sha = baseRef.data.object.sha;

    await this.octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha,
    });

    return branchName;
  }

  async createPullRequest(
    owner: string,
    repo: string,
    params: {
      title: string;
      body: string;
      head: string;
      base?: string;
    }
  ): Promise<{ number: number; html_url: string }> {
    const response = await this.octokit.pulls.create({
      owner,
      repo,
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base ?? 'main',
    });

    return {
      number: response.data.number,
      html_url: response.data.html_url,
    };
  }

  async addIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<void> {
    await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }

  async closeIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
    await this.octokit.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      state: 'closed',
    });
  }

  async verifyRepoAccess(owner: string, repo: string): Promise<boolean> {
    try {
      const response = await this.octokit.repos.get({ owner, repo });
      return response.data.permissions?.push ?? false;
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        return false;
      }
      throw error;
    }
  }

  async getIssueParent(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<IssueParent | null> {
    try {
      const response = await this.octokit.request(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
        { owner, repo, issue_number: issueNumber }
      );

      // The sub_issues endpoint returns an object with a parent property, not an array
      const data = response.data as unknown as { parent?: { number: number; state: string } };
      if (data.parent) {
        return {
          number: data.parent.number,
          state: data.parent.state as 'open' | 'closed',
        };
      }
      return null;
    } catch {
      // Graceful degradation - sub-issues API may not be available
      return null;
    }
  }

  async getPrStatus(owner: string, repo: string, prNumber: number): Promise<PrStatus> {
    const prResponse = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const pr = prResponse.data;
    const sha = pr.head.sha;

    // Determine PR state
    let state: 'open' | 'closed' | 'merged' = pr.state as 'open' | 'closed';
    if (pr.state === 'closed' && pr.merged) {
      state = 'merged';
    }

    // Get CI checks
    const checksResponse = await this.octokit.checks.listForRef({
      owner,
      repo,
      ref: sha,
    });

    const checks: CheckStatus[] = checksResponse.data.check_runs.map((run) => ({
      name: run.name,
      status: this.mapCheckConclusion(run.conclusion),
    }));

    const ciStatus = this.calculateCiStatus(checks);

    // Get reviews
    const reviewsResponse = await this.octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      { owner, repo, pull_number: prNumber }
    );

    const reviews = reviewsResponse.data;
    const approved = reviews.some((r: any) => r.state === 'APPROVED');
    const changesRequested = reviews.some((r: any) => r.state === 'CHANGES_REQUESTED');
    const reviewers = [...new Set(reviews.map((r: any) => r.user?.login).filter(Boolean))];

    return {
      prNumber,
      state,
      mergeable: pr.mergeable,
      ci: {
        status: ciStatus,
        checks,
      },
      reviews: {
        approved,
        changesRequested,
        reviewers: reviewers as string[],
      },
      autoMerge: {
        enabled: pr.auto_merge !== null,
      },
    };
  }

  private mapCheckConclusion(conclusion: string | null): CheckStatus['status'] {
    switch (conclusion) {
      case 'success':
        return 'success';
      case 'failure':
      case 'timed_out':
      case 'cancelled':
        return 'failure';
      case 'neutral':
        return 'neutral';
      case 'skipped':
        return 'skipped';
      default:
        return 'in_progress';
    }
  }

  private calculateCiStatus(checks: CheckStatus[]): 'pending' | 'passing' | 'failing' | 'none' {
    if (checks.length === 0) return 'none';

    const hasFailure = checks.some((c) => c.status === 'failure');
    if (hasFailure) return 'failing';

    const hasPending = checks.some((c) => c.status === 'in_progress' || c.status === 'queued');
    if (hasPending) return 'pending';

    return 'passing';
  }

  private mapApiIssue(
    apiIssue: {
      number: number;
      title: string;
      body?: string | null;
      state?: string;
      created_at: string;
      updated_at: string;
      labels: (string | { name?: string; color?: string | null; description?: string | null })[];
      assignees?: { login: string }[] | null;
      html_url: string;
    },
    owner: string,
    repo: string
  ): Issue {
    return {
      number: apiIssue.number,
      title: apiIssue.title,
      body: apiIssue.body ?? null,
      state: (apiIssue.state as 'open' | 'closed') ?? 'open',
      created_at: apiIssue.created_at,
      updated_at: apiIssue.updated_at,
      labels: apiIssue.labels.map((label): Label => {
        if (typeof label === 'string') {
          return { name: label, color: '', description: null };
        }
        return {
          name: label.name ?? '',
          color: label.color ?? '',
          description: label.description ?? null,
        };
      }),
      assignees: apiIssue.assignees?.map((a) => ({ login: a.login })) ?? [],
      html_url: apiIssue.html_url,
      repository: {
        owner,
        repo,
        full_name: `${owner}/${repo}`,
      },
    };
  }
}

let globalGitHubService: GitHubService | null = null;

export function getGitHubService(token?: string): GitHubService {
  if (!globalGitHubService && !token) {
    throw new Error('GitHubService not initialized. Provide a token.');
  }
  if (!globalGitHubService && token) {
    globalGitHubService = new GitHubService({ token });
  }
  return globalGitHubService!;
}

export function initializeGitHubService(token: string): GitHubService {
  globalGitHubService = new GitHubService({ token });
  return globalGitHubService;
}

export function resetGitHubService(): void {
  globalGitHubService = null;
}
