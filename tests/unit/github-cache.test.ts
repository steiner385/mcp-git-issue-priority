import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../../src/services/github.js';
import { type CachedIssues } from '../../src/services/cache.js';
import type { Issue } from '../../src/models/index.js';
import type { PrStatus } from '../../src/models/index.js';
import { makeNullCache } from './null-cache.js';
import { makeNullMetrics } from './null-metrics.js';

export { makeNullCache };

const makeIssue = (number: number, updatedAt = '2026-01-01T00:00:00Z'): Issue => ({
  number,
  title: `Issue ${number}`,
  body: null,
  state: 'open',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: updatedAt,
  labels: [],
  assignees: [],
  html_url: `https://github.com/owner/repo/issues/${number}`,
  repository: { owner: 'owner', repo: 'repo', full_name: 'owner/repo' },
});

const makeGQLNode = (number: number, state: 'OPEN' | 'CLOSED' = 'OPEN', updatedAt = '2026-01-02T00:00:00Z') => ({
  number,
  title: `Issue ${number}`,
  body: null,
  state,
  url: `https://github.com/owner/repo/issues/${number}`,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt,
  labels: { nodes: [] },
  assignees: { nodes: [] },
  parent: null,
});

const makeGQLPage = (nodes: any[], hasNextPage = false, endCursor: string | null = null) => ({
  repository: { issues: { pageInfo: { hasNextPage, endCursor }, nodes } },
});

const makeGQLLabelsResponse = (names: string[]) => ({
  repository: { labels: { nodes: names.map((n) => ({ name: n, color: '000', description: null })) } },
});

const makeOpenPrStatus = (): PrStatus => ({
  prNumber: 1,
  state: 'open',
  mergeable: true,
  ci: { status: 'passing', checks: [] },
  reviews: { approved: false, changesRequested: false, reviewers: [] },
  autoMerge: { enabled: false },
});

describe('GitHubService — cache reads', () => {
  let github: GitHubService;
  let mockCache: ReturnType<typeof makeNullCache>;
  let mockOctokit: any;

  beforeEach(() => {
    mockCache = makeNullCache();
    github = new GitHubService({ token: 'test-token', cacheService: mockCache, metricsService: makeNullMetrics() });
    mockOctokit = {
      graphql: vi.fn(),
      paginate: vi.fn(),
      issues: { listForRepo: vi.fn(), createLabel: vi.fn() },
      pulls: { get: vi.fn() },
      checks: { listForRef: vi.fn() },
      request: vi.fn(),
    };
    (github as any).octokit = mockOctokit;
  });

  // --- listOpenIssuesWithParents ---

  describe('listOpenIssuesWithParents', () => {
    it('does a full GraphQL fetch on cache miss and writes cache', async () => {
      mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([makeGQLNode(1)]));

      const { issues } = await github.listOpenIssuesWithParents('owner', 'repo');

      expect(issues).toHaveLength(1);
      expect(mockOctokit.graphql).toHaveBeenCalledOnce();
      expect(mockCache.setIssues).toHaveBeenCalledOnce();
    });

    it('performs a delta fetch (with since param) when cache hit with lastModifiedAt', async () => {
      const cached: CachedIssues = { issues: [makeIssue(1)], dependencies: [] };
      (mockCache.getIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: cached,
        lastModifiedAt: '2026-01-01T12:00:00.000Z',
      });
      mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([makeGQLNode(2)]));

      const { issues } = await github.listOpenIssuesWithParents('owner', 'repo');

      expect(issues).toHaveLength(2);
      const gqlCall = mockOctokit.graphql.mock.calls[0];
      expect(gqlCall[1]).toMatchObject({ since: '2026-01-01T12:00:00.000Z' });
      expect(mockCache.setIssues).toHaveBeenCalledOnce();
    });

    it('evicts closed issues from the cache during delta merge', async () => {
      const cached: CachedIssues = { issues: [makeIssue(1), makeIssue(2)], dependencies: [] };
      (mockCache.getIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: cached,
        lastModifiedAt: '2026-01-01T12:00:00.000Z',
      });
      mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([makeGQLNode(1, 'CLOSED')]));

      const { issues } = await github.listOpenIssuesWithParents('owner', 'repo');

      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(2);
    });

    it('falls back to full fetch when delta GraphQL throws', async () => {
      (mockCache.getIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { issues: [makeIssue(1)], dependencies: [] },
        lastModifiedAt: '2026-01-01T12:00:00.000Z',
      });
      mockOctokit.graphql
        .mockRejectedValueOnce(new Error('GraphQL error'))
        .mockResolvedValueOnce(makeGQLPage([makeGQLNode(1)]));

      const { issues } = await github.listOpenIssuesWithParents('owner', 'repo');

      expect(issues).toHaveLength(1);
      expect(mockOctokit.graphql).toHaveBeenCalledTimes(2);
    });

    it('updates dependency map correctly from delta', async () => {
      const cached: CachedIssues = { issues: [makeIssue(1), makeIssue(2)], dependencies: [[2, 1]] };
      (mockCache.getIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: cached,
        lastModifiedAt: '2026-01-01T12:00:00.000Z',
      });
      const node2 = { ...makeGQLNode(2), parent: { number: 1, state: 'CLOSED' } };
      mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([node2]));

      const { dependencies } = await github.listOpenIssuesWithParents('owner', 'repo');

      expect(dependencies.has(2)).toBe(false);
    });
  });

  // --- listOpenIssues ---

  describe('listOpenIssues', () => {
    it('returns issues from cache when available (delta returns empty)', async () => {
      const cached: CachedIssues = { issues: [makeIssue(1)], dependencies: [] };
      (mockCache.getIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: cached,
        lastModifiedAt: '2026-01-01T12:00:00.000Z',
      });
      mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([]));

      const issues = await github.listOpenIssues('owner', 'repo');

      expect(issues).toHaveLength(1);
    });

    it('fetches via listOpenIssuesWithParents on cache miss', async () => {
      mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([makeGQLNode(1)]));

      const issues = await github.listOpenIssues('owner', 'repo');

      expect(issues).toHaveLength(1);
      expect(mockOctokit.graphql).toHaveBeenCalledOnce();
    });
  });

  // --- ensureLabelsExist ---

  describe('ensureLabelsExist', () => {
    it('skips GraphQL call when all labels are in cache', async () => {
      const allLabels = [
        'priority:critical', 'priority:high', 'priority:medium', 'priority:low',
        'type:bug', 'type:feature', 'type:chore', 'type:docs',
        'status:backlog', 'status:in-progress', 'status:in-review', 'status:blocked',
      ];
      (mockCache.getLabels as ReturnType<typeof vi.fn>).mockResolvedValue(allLabels);

      await github.ensureLabelsExist('owner', 'repo');

      expect(mockOctokit.graphql).not.toHaveBeenCalled();
      expect(mockOctokit.issues.createLabel).not.toHaveBeenCalled();
    });

    it('fetches from GraphQL and writes labels cache on cache miss', async () => {
      mockOctokit.graphql.mockResolvedValueOnce(makeGQLLabelsResponse([
        'priority:critical', 'priority:high', 'priority:medium', 'priority:low',
        'type:bug', 'type:feature', 'type:chore', 'type:docs',
        'status:backlog', 'status:in-progress', 'status:in-review', 'status:blocked',
      ]));

      await github.ensureLabelsExist('owner', 'repo');

      expect(mockOctokit.graphql).toHaveBeenCalledOnce();
      expect(mockCache.setLabels).toHaveBeenCalledOnce();
    });
  });

  // --- getPrStatus ---

  describe('getPrStatus', () => {
    it('returns cached status without API call when cache hit', async () => {
      const status = makeOpenPrStatus();
      (mockCache.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue(status);

      const result = await github.getPrStatus('owner', 'repo', 1);

      expect(result).toEqual(status);
      expect(mockOctokit.graphql).not.toHaveBeenCalled();
      expect(mockOctokit.pulls.get).not.toHaveBeenCalled();
    });

    it('fetches from GitHub and writes cache on cache miss', async () => {
      const gqlResponse = {
        repository: {
          pullRequest: {
            number: 1, state: 'OPEN', merged: false, mergeable: 'MERGEABLE',
            autoMergeRequest: null, headRefOid: 'abc',
            commits: { nodes: [{ commit: { checkSuites: { nodes: [] } } }] },
            reviews: { nodes: [] },
          },
        },
      };
      mockOctokit.graphql.mockResolvedValueOnce(gqlResponse);

      await github.getPrStatus('owner', 'repo', 1);

      expect(mockCache.setPrStatus).toHaveBeenCalledOnce();
    });
  });
});

describe('GitHubService — cache invalidations on writes', () => {
  let github: GitHubService;
  let mockCache: ReturnType<typeof makeNullCache>;
  let mockOctokit: any;

  beforeEach(() => {
    mockCache = makeNullCache();
    github = new GitHubService({ token: 'test-token', cacheService: mockCache, metricsService: makeNullMetrics() });
    mockOctokit = {
      issues: {
        removeLabel: vi.fn().mockResolvedValue(undefined),
        addLabels: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue({
          data: {
            number: 99, title: 'New', body: '', state: 'open',
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
            labels: [], assignees: [],
            html_url: 'https://github.com/owner/repo/issues/99',
          },
        }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        createLabel: vi.fn().mockResolvedValue(undefined),
      },
      graphql: vi.fn().mockResolvedValue({
        repository: { labels: { nodes: [] } },
      }),
    };
    (github as any).octokit = mockOctokit;
  });

  it('patches labels in cache after updateIssueLabel (no full invalidation)', async () => {
    await github.updateIssueLabel('owner', 'repo', 1, ['status:in-progress'], ['status:backlog']);

    expect(mockCache.patchIssueLabels).toHaveBeenCalledWith('owner', 'repo', 1, ['status:in-progress'], ['status:backlog']);
    expect(mockCache.invalidateIssues).not.toHaveBeenCalled();
  });

  it('adds new issue to cache after createIssue (no full invalidation)', async () => {
    const allLabelNames = [
      'priority:critical', 'priority:high', 'priority:medium', 'priority:low',
      'type:bug', 'type:feature', 'type:chore', 'type:docs',
      'status:backlog', 'status:in-progress', 'status:in-review', 'status:blocked',
    ];
    (mockCache.getLabels as ReturnType<typeof vi.fn>).mockResolvedValue(allLabelNames);

    await github.createIssue({
      owner: 'owner', repo: 'repo', title: 'New issue', priority: 'high', type: 'bug',
    });

    expect(mockCache.addIssue).toHaveBeenCalledWith('owner', 'repo', expect.objectContaining({ number: 99 }));
    expect(mockCache.invalidateIssues).not.toHaveBeenCalled();
  });

  it('evicts issue from cache after closeIssue (no full invalidation)', async () => {
    await github.closeIssue('owner', 'repo', 1);

    expect(mockCache.evictIssue).toHaveBeenCalledWith('owner', 'repo', 1);
    expect(mockCache.invalidateIssues).not.toHaveBeenCalled();
  });

  it('evicts issue from cache after updateIssueState closed', async () => {
    await github.updateIssueState('owner', 'repo', 1, 'closed');

    expect(mockCache.evictIssue).toHaveBeenCalledWith('owner', 'repo', 1);
    expect(mockCache.invalidateIssues).not.toHaveBeenCalled();
  });

  it('fully invalidates cache after updateIssueState open (re-open adds unknown issue)', async () => {
    await github.updateIssueState('owner', 'repo', 1, 'open');

    expect(mockCache.invalidateIssues).toHaveBeenCalledWith('owner', 'repo');
    expect(mockCache.evictIssue).not.toHaveBeenCalled();
  });
});
