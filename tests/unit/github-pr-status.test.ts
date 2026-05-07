import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../../src/services/github.js';
import { makeNullCache } from './null-cache.js';
import { makeNullMetrics } from './null-metrics.js';

describe('GitHubService PR Status', () => {
  let github: GitHubService;
  let mockOctokit: any;

  beforeEach(() => {
    mockOctokit = {
      pulls: { get: vi.fn() },
      checks: { listForRef: vi.fn() },
      request: vi.fn(),
    };
    github = new GitHubService({ token: 'test-token', cacheService: makeNullCache(), metricsService: makeNullMetrics() });
    (github as any).octokit = mockOctokit;
  });

  describe('getPrStatus', () => {
    it('returns complete PR status', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          number: 42,
          state: 'open',
          mergeable: true,
          head: { sha: 'abc123' },
          auto_merge: { enabled_by: { login: 'user' } },
        },
      });

      mockOctokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [
            { name: 'build', conclusion: 'success' },
            { name: 'test', conclusion: 'success' },
          ],
        },
      });

      mockOctokit.request.mockResolvedValue({
        data: [
          { state: 'APPROVED', user: { login: 'alice' } },
        ],
      });

      const status = await github.getPrStatus('owner', 'repo', 42);

      expect(status.prNumber).toBe(42);
      expect(status.state).toBe('open');
      expect(status.mergeable).toBe(true);
      expect(status.ci.status).toBe('passing');
      expect(status.reviews.approved).toBe(true);
      expect(status.autoMerge.enabled).toBe(true);
    });

    it('detects merged PR', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          number: 42,
          state: 'closed',
          merged: true,
          mergeable: null,
          head: { sha: 'abc123' },
          auto_merge: null,
        },
      });

      mockOctokit.checks.listForRef.mockResolvedValue({
        data: { check_runs: [] },
      });

      mockOctokit.request.mockResolvedValue({ data: [] });

      const status = await github.getPrStatus('owner', 'repo', 42);

      expect(status.state).toBe('merged');
    });

    it('detects failing CI', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          number: 42,
          state: 'open',
          mergeable: true,
          head: { sha: 'abc123' },
          auto_merge: null,
        },
      });

      mockOctokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [
            { name: 'build', conclusion: 'success' },
            { name: 'test', conclusion: 'failure' },
          ],
        },
      });

      mockOctokit.request.mockResolvedValue({ data: [] });

      const status = await github.getPrStatus('owner', 'repo', 42);

      expect(status.ci.status).toBe('failing');
      expect(status.ci.checks).toHaveLength(2);
    });

    it('detects pending CI', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          number: 42,
          state: 'open',
          mergeable: true,
          head: { sha: 'abc123' },
          auto_merge: null,
        },
      });

      mockOctokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [
            { name: 'build', conclusion: 'success' },
            { name: 'test', conclusion: null }, // in progress
          ],
        },
      });

      mockOctokit.request.mockResolvedValue({ data: [] });

      const status = await github.getPrStatus('owner', 'repo', 42);

      expect(status.ci.status).toBe('pending');
    });

    it('detects changes requested in review', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          number: 42,
          state: 'open',
          mergeable: true,
          head: { sha: 'abc123' },
          auto_merge: null,
        },
      });

      mockOctokit.checks.listForRef.mockResolvedValue({
        data: { check_runs: [] },
      });

      mockOctokit.request.mockResolvedValue({
        data: [
          { state: 'CHANGES_REQUESTED', user: { login: 'bob' } },
        ],
      });

      const status = await github.getPrStatus('owner', 'repo', 42);

      expect(status.reviews.changesRequested).toBe(true);
      expect(status.reviews.approved).toBe(false);
      expect(status.reviews.reviewers).toContain('bob');
    });

    it('handles no checks (none status)', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          number: 42,
          state: 'open',
          mergeable: true,
          head: { sha: 'abc123' },
          auto_merge: null,
        },
      });

      mockOctokit.checks.listForRef.mockResolvedValue({
        data: { check_runs: [] },
      });

      mockOctokit.request.mockResolvedValue({ data: [] });

      const status = await github.getPrStatus('owner', 'repo', 42);

      expect(status.ci.status).toBe('none');
      expect(status.ci.checks).toHaveLength(0);
    });

    it('deduplicates reviewers', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          number: 42,
          state: 'open',
          mergeable: true,
          head: { sha: 'abc123' },
          auto_merge: null,
        },
      });

      mockOctokit.checks.listForRef.mockResolvedValue({
        data: { check_runs: [] },
      });

      mockOctokit.request.mockResolvedValue({
        data: [
          { state: 'COMMENTED', user: { login: 'alice' } },
          { state: 'APPROVED', user: { login: 'alice' } },
          { state: 'APPROVED', user: { login: 'bob' } },
        ],
      });

      const status = await github.getPrStatus('owner', 'repo', 42);

      expect(status.reviews.reviewers).toEqual(['alice', 'bob']);
    });
  });
});

describe('getPrStatus — GraphQL path', () => {
  let github: GitHubService;
  let mockOctokit: any;

  beforeEach(() => {
    mockOctokit = {
      graphql: vi.fn(),
      pulls: { get: vi.fn() },
      checks: { listForRef: vi.fn() },
      request: vi.fn(),
    };
    github = new GitHubService({ token: 'test-token', cacheService: makeNullCache(), metricsService: makeNullMetrics() });
    (github as any).octokit = mockOctokit;
  });

  const makeGQLPrResponse = (overrides: any = {}) => ({
    repository: {
      pullRequest: {
        number: 42,
        state: 'OPEN',
        merged: false,
        mergeable: 'MERGEABLE',
        autoMergeRequest: { mergeMethod: 'SQUASH' },
        headRefOid: 'abc123',
        commits: {
          nodes: [{
            commit: {
              checkSuites: {
                nodes: [{
                  checkRuns: {
                    nodes: [
                      { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
                      { name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' },
                    ],
                  },
                }],
              },
            },
          }],
        },
        reviews: {
          nodes: [{ state: 'APPROVED', author: { login: 'alice' } }],
        },
        ...overrides,
      },
    },
  });

  it('returns complete PR status via GraphQL', async () => {
    mockOctokit.graphql.mockResolvedValueOnce(makeGQLPrResponse());

    const status = await github.getPrStatus('owner', 'repo', 42);

    expect(status.prNumber).toBe(42);
    expect(status.state).toBe('open');
    expect(status.mergeable).toBe(true);
    expect(status.ci.status).toBe('passing');
    expect(status.reviews.approved).toBe(true);
    expect(status.autoMerge.enabled).toBe(true);
    expect(mockOctokit.pulls.get).not.toHaveBeenCalled();
  });

  it('detects merged PR via GraphQL', async () => {
    mockOctokit.graphql.mockResolvedValueOnce(
      makeGQLPrResponse({ state: 'CLOSED', merged: true, mergeable: null })
    );

    const status = await github.getPrStatus('owner', 'repo', 42);
    expect(status.state).toBe('merged');
  });

  it('detects pending CI via GraphQL (in_progress check run)', async () => {
    mockOctokit.graphql.mockResolvedValueOnce(
      makeGQLPrResponse({
        commits: {
          nodes: [{
            commit: {
              checkSuites: {
                nodes: [{
                  checkRuns: {
                    nodes: [
                      { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
                      { name: 'test', conclusion: null, status: 'IN_PROGRESS' },
                    ],
                  },
                }],
              },
            },
          }],
        },
      })
    );

    const status = await github.getPrStatus('owner', 'repo', 42);
    expect(status.ci.status).toBe('pending');
  });

  it('falls back to REST when GraphQL throws', async () => {
    mockOctokit.graphql.mockRejectedValueOnce(new Error('GraphQL error'));
    mockOctokit.pulls.get.mockResolvedValueOnce({
      data: {
        number: 42, state: 'open', mergeable: true,
        head: { sha: 'abc123' }, auto_merge: null,
      },
    });
    mockOctokit.checks.listForRef.mockResolvedValueOnce({
      data: { check_runs: [] },
    });
    mockOctokit.request.mockResolvedValueOnce({ data: [] });

    const status = await github.getPrStatus('owner', 'repo', 42);

    expect(status.prNumber).toBe(42);
    expect(mockOctokit.pulls.get).toHaveBeenCalledTimes(1);
  });
});
