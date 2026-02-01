import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../../src/services/github.js';

describe('GitHubService Sub-Issues', () => {
  let github: GitHubService;
  let mockOctokit: any;

  beforeEach(() => {
    mockOctokit = {
      request: vi.fn(),
    };
    github = new GitHubService({ token: 'test-token' });
    (github as any).octokit = mockOctokit;
  });

  describe('getIssueParent', () => {
    it('returns parent issue number when issue has parent', async () => {
      mockOctokit.request.mockResolvedValue({
        data: {
          parent: { number: 42, state: 'open' },
        },
      });

      const parent = await github.getIssueParent('owner', 'repo', 45);
      expect(parent).toEqual({ number: 42, state: 'open' });
    });

    it('returns null when issue has no parent', async () => {
      mockOctokit.request.mockResolvedValue({
        data: { parent: null },
      });

      const parent = await github.getIssueParent('owner', 'repo', 45);
      expect(parent).toBeNull();
    });

    it('returns null on API error (graceful degradation)', async () => {
      mockOctokit.request.mockRejectedValue(new Error('API error'));

      const parent = await github.getIssueParent('owner', 'repo', 45);
      expect(parent).toBeNull();
    });
  });
});
