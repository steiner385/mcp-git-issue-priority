import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';
import type { Issue, Label, IssuePriority, IssueType, PrStatus, CheckStatus } from '../models/index.js';
import { LABEL_DEFINITIONS } from '../models/index.js';
import {
  LIST_ISSUES_WITH_PARENTS_QUERY,
  LIST_ISSUES_QUERY,

  LIST_ISSUES_DELTA_QUERY,
  GET_PR_STATUS_QUERY,
  GET_REPO_LABELS_QUERY,
  type GQLListIssuesResponse,
  type GQLListIssuesNoParentResponse,

  type GQLListIssuesDeltaResponse,
  type GQLIssueNode,
  type GQLIssueNodeNoParent,
  type GQLPrStatusResponse,
  type GQLLabelsResponse,
} from './github-graphql.js';

import { type CacheService, type CachedIssues, getCacheService } from './cache.js';

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
  cacheService?: CacheService;
}

export class GitHubService {
  private octokit: InstanceType<typeof ThrottledOctokit>;
  private cacheService: CacheService;

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
    this.cacheService = options.cacheService ?? getCacheService();
  }

  async ensureLabelsExist(owner: string, repo: string): Promise<void> {
    const allLabels = {
      ...LABEL_DEFINITIONS.priority,
      ...LABEL_DEFINITIONS.type,
      ...LABEL_DEFINITIONS.status,
    };

    const cached = await this.cacheService.getLabels(owner, repo);
    if (cached) {
      const cachedSet = new Set(cached);
      if (Object.keys(allLabels).every((name) => cachedSet.has(name))) return;
    }

    try {
      type OctokitWithGraphQL = { graphql: <T>(query: string, vars?: Record<string, unknown>) => Promise<T> };
      const gql = this.octokit as unknown as OctokitWithGraphQL;
      const response = await gql.graphql<GQLLabelsResponse>(GET_REPO_LABELS_QUERY, { owner, repo });
      const existingNames = new Set(response.repository.labels.nodes.map((l) => l.name));

      let createdAny = false;
      for (const [name, definition] of Object.entries(allLabels)) {
        if (!existingNames.has(name)) {
          await this.octokit.issues.createLabel({
            owner,
            repo,
            name,
            color: definition.color,
            description: definition.description,
          });
          createdAny = true;
        }
      }

      if (createdAny) {
        await this.cacheService.invalidateLabels(owner, repo);
      } else {
        await this.cacheService.setLabels(owner, repo, [...existingNames]);
      }
    } catch {
      await this.ensureLabelsExistREST(owner, repo, allLabels);
    }
  }

  private async ensureLabelsExistREST(
    owner: string,
    repo: string,
    allLabels: Record<string, { color: string; description: string }>
  ): Promise<void> {
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

    await this.cacheService.invalidateIssues(owner, repo);
    return this.mapApiIssue(response.data, owner, repo);
  }

  async listOpenIssues(owner: string, repo: string): Promise<Issue[]> {
    const { issues } = await this.listOpenIssuesWithParents(owner, repo);
    return issues;
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<Issue> {
    const response = await this.octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    return this.mapApiIssue(response.data, owner, repo);
  }

  async listOpenIssuesWithParents(
    owner: string,
    repo: string
  ): Promise<{ issues: Issue[]; dependencies: Map<number, number | null> }> {
    const cached = await this.cacheService.getIssues(owner, repo);

    if (cached) {
      try {
        const deltaNodes = await this.fetchDeltaNodes(owner, repo, cached.lastModifiedAt);
        const merged = this.mergeIssueDelta(owner, repo, cached.data, deltaNodes);
        const lastModifiedAt = this.computeLastModifiedAt(merged.issues);
        await this.cacheService.setIssues(owner, repo, merged, lastModifiedAt);
        return {
          issues: merged.issues,
          dependencies: new Map(merged.dependencies),
        };
      } catch {
        // Delta failed — fall through to full fetch
      }
    }

    let result: { issues: Issue[]; dependencies: Map<number, number | null> };
    try {
      result = await this.fetchIssuesGraphQL(owner, repo, true);
    } catch {
      try {
        result = await this.fetchIssuesGraphQL(owner, repo, false);
      } catch {
        const issues = await this.listOpenIssuesFallback(owner, repo);
        result = { issues, dependencies: new Map() };
      }
    }

    const lastModifiedAt = this.computeLastModifiedAt(result.issues);
    await this.cacheService.setIssues(
      owner,
      repo,
      { issues: result.issues, dependencies: [...result.dependencies.entries()] },
      lastModifiedAt
    );
    return result;
  }

  private async fetchDeltaNodes(
    owner: string,
    repo: string,
    since: string
  ): Promise<GQLIssueNode[]> {
    type OctokitWithGraphQL = { graphql: <T>(query: string, vars?: Record<string, unknown>) => Promise<T> };
    const gql = (this.octokit as unknown as OctokitWithGraphQL).graphql;
    const allNodes: GQLIssueNode[] = [];
    let cursor: string | null = null;

    do {
      const result: GQLListIssuesDeltaResponse = await gql<GQLListIssuesDeltaResponse>(
        LIST_ISSUES_DELTA_QUERY,
        { owner, repo, since, cursor }
      );
      const page = result.repository.issues;
      allNodes.push(...(page.nodes as GQLIssueNode[]));
      cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
    } while (cursor);

    return allNodes;
  }

  private mergeIssueDelta(
    owner: string,
    repo: string,
    cached: CachedIssues,
    deltaNodes: GQLIssueNode[]
  ): CachedIssues {
    const issueMap = new Map<number, Issue>(cached.issues.map((i) => [i.number, i]));
    const depMap = new Map<number, number | null>(cached.dependencies);

    for (const node of deltaNodes) {
      if (node.state === 'OPEN') {
        issueMap.set(node.number, this.mapGQLNodeToIssue(node, owner, repo));
        if (node.parent && node.parent.state === 'OPEN') {
          depMap.set(node.number, node.parent.number);
        } else {
          depMap.delete(node.number);
        }
      } else {
        issueMap.delete(node.number);
        depMap.delete(node.number);
      }
    }

    return {
      issues: Array.from(issueMap.values()),
      dependencies: [...depMap.entries()],
    };
  }

  private computeLastModifiedAt(issues: Issue[]): string {
    if (issues.length === 0) return new Date().toISOString();
    return issues.reduce(
      (max, i) => (i.updated_at > max ? i.updated_at : max),
      issues[0].updated_at
    );
  }

  private mapGQLNodeToIssue(node: GQLIssueNodeNoParent, owner: string, repo: string): Issue {
    return {
      number: node.number,
      title: node.title,
      body: node.body,
      state: node.state.toLowerCase() as 'open' | 'closed',
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      labels: node.labels.nodes.map((l) => ({
        name: l.name,
        color: l.color,
        description: l.description,
      })),
      assignees: node.assignees.nodes.map((a) => ({ login: a.login })),
      html_url: node.url,
      repository: { owner, repo, full_name: `${owner}/${repo}` },
    };
  }

  private async fetchIssuesGraphQL(
    owner: string,
    repo: string,
    withParent: boolean
  ): Promise<{ issues: Issue[]; dependencies: Map<number, number | null> }> {
    type OctokitWithGraphQL = { graphql: <T>(query: string, vars?: Record<string, unknown>) => Promise<T> };
    const gql = (this.octokit as unknown as OctokitWithGraphQL).graphql;

    const query = withParent ? LIST_ISSUES_WITH_PARENTS_QUERY : LIST_ISSUES_QUERY;
    const allNodes: Array<GQLIssueNode | GQLIssueNodeNoParent> = [];
    let cursor: string | null = null;

    do {
      const result: GQLListIssuesResponse | GQLListIssuesNoParentResponse = await gql<GQLListIssuesResponse | GQLListIssuesNoParentResponse>(
        query,
        { owner, repo, cursor }
      );
      const issuesPage: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<GQLIssueNode | GQLIssueNodeNoParent> } = result.repository.issues;
      allNodes.push(...issuesPage.nodes);
      cursor = issuesPage.pageInfo.hasNextPage ? (issuesPage.pageInfo.endCursor ?? null) : null;
    } while (cursor);

    const issues: Issue[] = allNodes.map((node) => this.mapGQLNodeToIssue(node, owner, repo));

    const dependencies = new Map<number, number | null>();
    if (withParent) {
      for (const node of allNodes as GQLIssueNode[]) {
        if (node.parent && node.parent.state === 'OPEN') {
          dependencies.set(node.number, node.parent.number);
        }
      }
    }

    return { issues, dependencies };
  }

  private async listOpenIssuesFallback(owner: string, repo: string): Promise<Issue[]> {
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

    await this.cacheService.invalidateIssues(owner, repo);
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
    await this.cacheService.invalidateIssues(owner, repo);
  }

  async updateIssueState(
    owner: string,
    repo: string,
    issueNumber: number,
    state: 'open' | 'closed'
  ): Promise<void> {
    await this.octokit.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      state,
    });
    await this.cacheService.invalidateIssues(owner, repo);
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

      const data = response.data as unknown as { parent?: { number: number; state: string } };
      if (data.parent) {
        return {
          number: data.parent.number,
          state: data.parent.state as 'open' | 'closed',
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async getPrStatus(owner: string, repo: string, prNumber: number): Promise<PrStatus> {
    const cached = await this.cacheService.getPrStatus(owner, repo, prNumber);
    if (cached) return cached;

    try {
      type OctokitWithGraphQL = { graphql: <T>(query: string, vars?: Record<string, unknown>) => Promise<T> };
      const result = await (this.octokit as unknown as OctokitWithGraphQL).graphql<GQLPrStatusResponse>(
        GET_PR_STATUS_QUERY,
        { owner, repo, prNumber }
      );

      const pr = result.repository.pullRequest;
      if (!pr) {
        throw new Error(`PR #${prNumber} not found`);
      }

      let state: 'open' | 'closed' | 'merged' = pr.state.toLowerCase() as 'open' | 'closed';
      if (pr.state === 'CLOSED' && pr.merged) {
        state = 'merged';
      }

      const checkRuns = pr.commits.nodes.flatMap((c) =>
        c.commit.checkSuites.nodes.flatMap((s) => s.checkRuns.nodes)
      );

      const checks: CheckStatus[] = checkRuns.map((run) => ({
        name: run.name,
        status: this.mapCheckConclusion(run.conclusion),
      }));

      const ciStatus = this.calculateCiStatus(checks);

      const approved = pr.reviews.nodes.some((r) => r.state === 'APPROVED');
      const changesRequested = pr.reviews.nodes.some((r) => r.state === 'CHANGES_REQUESTED');
      const reviewers = [
        ...new Set(
          pr.reviews.nodes.map((r) => r.author?.login).filter((l): l is string => Boolean(l))
        ),
      ];

      const status: PrStatus = {
        prNumber,
        state,
        mergeable: pr.mergeable === 'MERGEABLE',
        ci: { status: ciStatus, checks },
        reviews: { approved, changesRequested, reviewers },
        autoMerge: { enabled: pr.autoMergeRequest !== null },
      };
      await this.cacheService.setPrStatus(owner, repo, prNumber, status);
      return status;
    } catch {
      const status = await this.getPrStatusREST(owner, repo, prNumber);
      await this.cacheService.setPrStatus(owner, repo, prNumber, status);
      return status;
    }
  }

  private async getPrStatusREST(owner: string, repo: string, prNumber: number): Promise<PrStatus> {
    const prResponse = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const pr = prResponse.data;
    const sha = pr.head.sha;

    let state: 'open' | 'closed' | 'merged' = pr.state as 'open' | 'closed';
    if (pr.state === 'closed' && pr.merged) {
      state = 'merged';
    }

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
    switch (conclusion?.toLowerCase()) {
      case 'success':
        return 'success';
      case 'failure':
      case 'timed_out':
      case 'cancelled':
      case 'action_required':
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
