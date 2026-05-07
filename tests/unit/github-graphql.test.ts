import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../../src/services/github.js';
import type { GQLListIssuesResponse } from '../../src/services/github-graphql.js';
import { makeNullCache } from './null-cache.js';

const makeIssueNode = (overrides: any = {}) => ({
  number: 1,
  title: 'Test issue',
  body: 'body',
  state: 'OPEN',
  url: 'https://github.com/owner/repo/issues/1',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  labels: { nodes: [{ name: 'priority:high', color: 'e11d48', description: null }] },
  assignees: { nodes: [] },
  parent: null,
  ...overrides,
});

const makeGQLPage = (
  nodes: any[],
  hasNextPage = false,
  endCursor: string | null = null
): GQLListIssuesResponse => ({
  repository: {
    issues: {
      pageInfo: { hasNextPage, endCursor },
      nodes,
    },
  },
});

describe('GitHubService GraphQL — listOpenIssuesWithParents', () => {
  let github: GitHubService;
  let mockOctokit: any;

  beforeEach(() => {
    mockOctokit = {
      graphql: vi.fn(),
      paginate: vi.fn(),
      issues: { listForRepo: vi.fn() },
      request: vi.fn(),
    };
    github = new GitHubService({ token: 'test-token', cacheService: makeNullCache() });
    (github as any).octokit = mockOctokit;
  });

  it('returns mapped issues and empty dependencies when no parents', async () => {
    mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([makeIssueNode()]));

    const { issues, dependencies } = await github.listOpenIssuesWithParents('owner', 'repo');

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
    expect(issues[0].html_url).toBe('https://github.com/owner/repo/issues/1');
    expect(issues[0].repository.full_name).toBe('owner/repo');
    expect(dependencies.size).toBe(0);
  });

  it('populates dependencies map for issues with an open parent', async () => {
    const child = makeIssueNode({ number: 2, parent: { number: 1, state: 'OPEN' } });
    mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([child]));

    const { dependencies } = await github.listOpenIssuesWithParents('owner', 'repo');

    expect(dependencies.get(2)).toBe(1);
  });

  it('does NOT add to dependencies when parent is closed', async () => {
    const child = makeIssueNode({ number: 3, parent: { number: 1, state: 'CLOSED' } });
    mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([child]));

    const { dependencies } = await github.listOpenIssuesWithParents('owner', 'repo');

    expect(dependencies.size).toBe(0);
  });

  it('paginates until hasNextPage is false', async () => {
    const page1 = makeGQLPage([makeIssueNode({ number: 1 })], true, 'cursor-abc');
    const page2 = makeGQLPage([makeIssueNode({ number: 2 })], false, null);
    mockOctokit.graphql.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const { issues } = await github.listOpenIssuesWithParents('owner', 'repo');

    expect(issues).toHaveLength(2);
    expect(mockOctokit.graphql).toHaveBeenCalledTimes(2);
    expect(mockOctokit.graphql.mock.calls[1][1]).toMatchObject({ cursor: 'cursor-abc' });
  });

  it('falls back to REST listOpenIssues when GraphQL throws', async () => {
    mockOctokit.graphql.mockRejectedValue(new Error('GraphQL not available'));
    mockOctokit.paginate = vi.fn().mockResolvedValueOnce([
      {
        number: 10, title: 'REST issue', body: null, state: 'open',
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
        labels: [], assignees: [],
        html_url: 'https://github.com/owner/repo/issues/10',
        pull_request: undefined,
      },
    ]);

    const { issues, dependencies } = await github.listOpenIssuesWithParents('owner', 'repo');

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(10);
    expect(dependencies.size).toBe(0);
    expect(mockOctokit.graphql).toHaveBeenCalledTimes(2);
  });

  it('maps GraphQL label nodes to Issue.labels correctly', async () => {
    const node = makeIssueNode({
      number: 5,
      labels: {
        nodes: [
          { name: 'priority:critical', color: 'b60205', description: 'Blocker' },
          { name: 'type:bug', color: 'd73a4a', description: null },
        ],
      },
    });
    mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([node]));

    const { issues } = await github.listOpenIssuesWithParents('owner', 'repo');

    expect(issues[0].labels).toHaveLength(2);
    expect(issues[0].labels[0]).toEqual({ name: 'priority:critical', color: 'b60205', description: 'Blocker' });
  });
});
