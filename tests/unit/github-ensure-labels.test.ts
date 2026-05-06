import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../../src/services/github.js';
import { LABEL_DEFINITIONS } from '../../src/models/issue.js';

// Build the full set of 12 label names from LABEL_DEFINITIONS
const ALL_LABEL_NAMES = [
  ...Object.keys(LABEL_DEFINITIONS.priority),
  ...Object.keys(LABEL_DEFINITIONS.type),
  ...Object.keys(LABEL_DEFINITIONS.status),
];

const makeGQLLabelsResponse = (labelNames: string[]) => ({
  repository: {
    labels: {
      nodes: labelNames.map((name) => ({ name, color: '000000', description: null })),
    },
  },
});

describe('GitHubService.ensureLabelsExist — GraphQL bulk fetch', () => {
  let github: GitHubService;
  let mockOctokit: any;

  beforeEach(() => {
    mockOctokit = {
      graphql: vi.fn(),
      issues: {
        createLabel: vi.fn().mockResolvedValue(undefined),
      },
    };
    github = new GitHubService({ token: 'test-token' });
    (github as any).octokit = mockOctokit;
  });

  it('fetches labels once and creates only missing ones', async () => {
    // Return 10 of the 12 labels from GraphQL — expect exactly 2 createLabel calls
    const presentLabels = ALL_LABEL_NAMES.slice(0, 10);
    const missingLabels = ALL_LABEL_NAMES.slice(10);
    expect(missingLabels).toHaveLength(2); // sanity check

    mockOctokit.graphql.mockResolvedValueOnce(makeGQLLabelsResponse(presentLabels));

    await github.ensureLabelsExist('owner', 'repo');

    expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
    expect(mockOctokit.issues.createLabel).toHaveBeenCalledTimes(2);

    const createdNames = mockOctokit.issues.createLabel.mock.calls.map(
      (call: any[]) => call[0].name
    );
    expect(createdNames).toEqual(expect.arrayContaining(missingLabels));
    expect(createdNames).not.toEqual(expect.arrayContaining(presentLabels));
  });

  it('skips all createLabel calls when all labels already exist', async () => {
    mockOctokit.graphql.mockResolvedValueOnce(makeGQLLabelsResponse(ALL_LABEL_NAMES));

    await github.ensureLabelsExist('owner', 'repo');

    expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
    expect(mockOctokit.issues.createLabel).not.toHaveBeenCalled();
  });

  it('falls back to per-label REST approach when GraphQL throws', async () => {
    mockOctokit.graphql.mockRejectedValueOnce(new Error('GraphQL not available'));
    // REST fallback: getLabel throws 404 for each label → createLabel called for each
    mockOctokit.issues.getLabel = vi.fn().mockRejectedValue({ status: 404 });

    await github.ensureLabelsExist('owner', 'repo');

    expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
    expect(mockOctokit.issues.createLabel).toHaveBeenCalledTimes(12);
  });
});
