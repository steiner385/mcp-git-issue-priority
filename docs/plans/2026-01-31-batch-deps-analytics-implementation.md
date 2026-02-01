# Batch, Dependencies, and Analytics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add batch implementation orchestration, sub-issues dependency tracking, PR status checking, bulk operations, and workflow analytics to the MCP server.

**Architecture:** Five new tools with supporting models and services. Dependencies use GitHub's sub-issues API to apply a 0.1x priority penalty to blocked issues. Batch implementation uses a stateful orchestrator pattern where AI calls back after each issue.

**Tech Stack:** TypeScript, Zod schemas, Octokit REST API, file-based state persistence.

---

## Task 1: Add Batches Directory to Config

**Files:**
- Modify: `src/config/index.ts`

**Step 1: Write the failing test**

Create `tests/unit/config.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { getBatchesDir } from '../../src/config/index.js';
import { homedir } from 'os';
import { join } from 'path';

describe('Config', () => {
  describe('getBatchesDir', () => {
    it('returns correct batches directory path', () => {
      const expected = join(homedir(), '.mcp-git-issue-priority', 'batches');
      expect(getBatchesDir()).toBe(expected);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/config.test.ts`
Expected: FAIL with "getBatchesDir is not exported"

**Step 3: Write minimal implementation**

In `src/config/index.ts`, add after `getLogsDir`:
```typescript
export function getBatchesDir(): string {
  return join(getBaseDir(), 'batches');
}
```

Update `ensureDirectories`:
```typescript
export async function ensureDirectories(): Promise<void> {
  const dirs = [getBaseDir(), getLocksDir(), getWorkflowDir(), getLogsDir(), getBatchesDir()];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config/index.ts tests/unit/config.test.ts
git commit -m "feat: add batches directory to config"
```

---

## Task 2: Create Batch State Model

**Files:**
- Create: `src/models/batch-state.ts`
- Modify: `src/models/index.ts`

**Step 1: Write the failing test**

Create `tests/unit/batch-state.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  BatchStateSchema,
  createBatchState,
  validateBatchState,
  type BatchState,
} from '../../src/models/batch-state.js';

describe('BatchState', () => {
  describe('createBatchState', () => {
    it('creates valid batch state with correct defaults', () => {
      const state = createBatchState('owner/repo', 5, [1, 2, 3, 4, 5]);

      expect(state.batchId).toMatch(/^[0-9a-f-]{36}$/);
      expect(state.repository).toBe('owner/repo');
      expect(state.totalCount).toBe(5);
      expect(state.completedCount).toBe(0);
      expect(state.currentIssue).toBeNull();
      expect(state.currentPr).toBeNull();
      expect(state.queue).toEqual([1, 2, 3, 4, 5]);
      expect(state.completed).toEqual([]);
      expect(state.status).toBe('in_progress');
    });
  });

  describe('validateBatchState', () => {
    it('validates correct batch state', () => {
      const state = createBatchState('owner/repo', 3, [1, 2, 3]);
      expect(validateBatchState(state)).not.toBeNull();
    });

    it('returns null for invalid batch state', () => {
      expect(validateBatchState({ invalid: true })).toBeNull();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/batch-state.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/models/batch-state.ts`:
```typescript
import { z } from 'zod';

export const CompletedIssueSchema = z.object({
  issue: z.number().int().positive(),
  pr: z.number().int().positive(),
  startedAt: z.string().datetime(),
  mergedAt: z.string().datetime(),
});

export type CompletedIssue = z.infer<typeof CompletedIssueSchema>;

export const BatchStateSchema = z.object({
  batchId: z.string().uuid(),
  repository: z.string(),
  totalCount: z.number().int().positive(),
  completedCount: z.number().int().nonnegative(),
  currentIssue: z.number().int().positive().nullable(),
  currentPr: z.number().int().positive().nullable(),
  queue: z.array(z.number().int().positive()),
  completed: z.array(CompletedIssueSchema),
  startedAt: z.string().datetime(),
  status: z.enum(['in_progress', 'completed', 'timeout', 'abandoned']),
});

export type BatchState = z.infer<typeof BatchStateSchema>;

export function createBatchState(
  repository: string,
  totalCount: number,
  queue: number[]
): BatchState {
  return {
    batchId: crypto.randomUUID(),
    repository,
    totalCount,
    completedCount: 0,
    currentIssue: null,
    currentPr: null,
    queue,
    completed: [],
    startedAt: new Date().toISOString(),
    status: 'in_progress',
  };
}

export function validateBatchState(data: unknown): BatchState | null {
  const result = BatchStateSchema.safeParse(data);
  return result.success ? result.data : null;
}
```

Update `src/models/index.ts`:
```typescript
export * from './batch-state.js';
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/batch-state.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/models/batch-state.ts src/models/index.ts tests/unit/batch-state.test.ts
git commit -m "feat: add batch state model"
```

---

## Task 3: Create PR Status Model

**Files:**
- Create: `src/models/pr-status.ts`
- Modify: `src/models/index.ts`

**Step 1: Write the failing test**

Create `tests/unit/pr-status.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  PrStatusSchema,
  CheckStatusSchema,
  validatePrStatus,
  type PrStatus,
} from '../../src/models/pr-status.js';

describe('PrStatus', () => {
  describe('PrStatusSchema', () => {
    it('validates complete PR status', () => {
      const status: PrStatus = {
        prNumber: 42,
        state: 'open',
        mergeable: true,
        ci: {
          status: 'passing',
          checks: [
            { name: 'build', status: 'success' },
            { name: 'test', status: 'success' },
          ],
        },
        reviews: {
          approved: true,
          changesRequested: false,
          reviewers: ['alice', 'bob'],
        },
        autoMerge: {
          enabled: true,
        },
      };

      expect(validatePrStatus(status)).not.toBeNull();
    });

    it('validates merged PR', () => {
      const status: PrStatus = {
        prNumber: 42,
        state: 'merged',
        mergeable: null,
        ci: { status: 'passing', checks: [] },
        reviews: { approved: true, changesRequested: false, reviewers: [] },
        autoMerge: { enabled: false },
      };

      expect(validatePrStatus(status)).not.toBeNull();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/pr-status.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/models/pr-status.ts`:
```typescript
import { z } from 'zod';

export const CheckStatusSchema = z.object({
  name: z.string(),
  status: z.enum(['queued', 'in_progress', 'success', 'failure', 'neutral', 'skipped']),
});

export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CiStatusSchema = z.object({
  status: z.enum(['pending', 'passing', 'failing', 'none']),
  checks: z.array(CheckStatusSchema),
});

export type CiStatus = z.infer<typeof CiStatusSchema>;

export const ReviewStatusSchema = z.object({
  approved: z.boolean(),
  changesRequested: z.boolean(),
  reviewers: z.array(z.string()),
});

export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const AutoMergeStatusSchema = z.object({
  enabled: z.boolean(),
});

export type AutoMergeStatus = z.infer<typeof AutoMergeStatusSchema>;

export const PrStatusSchema = z.object({
  prNumber: z.number().int().positive(),
  state: z.enum(['open', 'closed', 'merged']),
  mergeable: z.boolean().nullable(),
  ci: CiStatusSchema,
  reviews: ReviewStatusSchema,
  autoMerge: AutoMergeStatusSchema,
});

export type PrStatus = z.infer<typeof PrStatusSchema>;

export function validatePrStatus(data: unknown): PrStatus | null {
  const result = PrStatusSchema.safeParse(data);
  return result.success ? result.data : null;
}

export function isPrReadyToMerge(status: PrStatus): boolean {
  return (
    status.state === 'merged' ||
    (status.ci.status === 'passing' &&
      status.reviews.approved &&
      !status.reviews.changesRequested)
  );
}
```

Update `src/models/index.ts`:
```typescript
export * from './pr-status.js';
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/pr-status.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/models/pr-status.ts src/models/index.ts tests/unit/pr-status.test.ts
git commit -m "feat: add PR status model"
```

---

## Task 4: Add Blocked Penalty to Priority Scoring

**Files:**
- Modify: `src/models/priority-score.ts`
- Modify: `tests/unit/priority.test.ts`

**Step 1: Write the failing test**

Add to `tests/unit/priority.test.ts`:
```typescript
describe('blocked penalty', () => {
  it('applies 0.1x penalty when blockedByIssue is provided', () => {
    const issue = createMockIssue(1, ['priority:high']);
    const score = calculatePriorityScore(issue, { blockedByIssue: 42 });

    expect(score.blockedPenalty).toBe(0.1);
    expect(score.blockedByIssue).toBe(42);
    expect(score.totalScore).toBe((100 + 14) * 1.0 * 0.1); // 11.4
  });

  it('applies 1.0x penalty when not blocked', () => {
    const issue = createMockIssue(1, ['priority:high']);
    const score = calculatePriorityScore(issue);

    expect(score.blockedPenalty).toBe(1.0);
    expect(score.blockedByIssue).toBeNull();
    expect(score.totalScore).toBe(114);
  });

  it('combines blocking multiplier and blocked penalty', () => {
    const issue = createMockIssue(1, ['priority:high', 'blocking']);
    const score = calculatePriorityScore(issue, { blockedByIssue: 42 });

    expect(score.blockingMultiplier).toBe(1.5);
    expect(score.blockedPenalty).toBe(0.1);
    expect(score.totalScore).toBe((100 + 14) * 1.5 * 0.1); // 17.1
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/priority.test.ts`
Expected: FAIL with "blockedPenalty" not found

**Step 3: Write minimal implementation**

Update `src/models/priority-score.ts`:

Add to schema:
```typescript
export const PriorityScoreSchema = z.object({
  issueNumber: z.number().int().positive(),
  basePoints: z.number().int().nonnegative(),
  ageBonus: z.number().int().nonnegative(),
  blockingMultiplier: z.number().positive(),
  blockedPenalty: z.number().positive(),
  blockedByIssue: z.number().int().positive().nullable(),
  totalScore: z.number().nonnegative(),
});
```

Add constant:
```typescript
export const BLOCKED_PENALTY = 0.1;
```

Update function signature and implementation:
```typescript
export interface PriorityScoreOptions {
  blockedByIssue?: number | null;
}

export function calculatePriorityScore(
  issue: Issue,
  options?: PriorityScoreOptions
): PriorityScore {
  const priorityLabel = getPriorityLabel(issue);
  const basePoints = priorityLabel ? PRIORITY_BASE_POINTS[priorityLabel] : 0;

  const ageInDays = calculateAgeInDays(issue.created_at);
  const ageBonus = Math.min(ageInDays, MAX_AGE_BONUS);

  const blocksOthers = hasBlockingRelationship(issue);
  const blockingMultiplier = blocksOthers ? BLOCKING_MULTIPLIER : 1.0;

  const blockedByIssue = options?.blockedByIssue ?? null;
  const blockedPenalty = blockedByIssue ? BLOCKED_PENALTY : 1.0;

  const totalScore = (basePoints + ageBonus) * blockingMultiplier * blockedPenalty;

  return {
    issueNumber: issue.number,
    basePoints,
    ageBonus,
    blockingMultiplier,
    blockedPenalty,
    blockedByIssue,
    totalScore,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/priority.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/models/priority-score.ts tests/unit/priority.test.ts
git commit -m "feat: add blocked penalty to priority scoring"
```

---

## Task 5: Add Sub-Issues API to GitHub Service

**Files:**
- Modify: `src/services/github.ts`

**Step 1: Write the failing test**

Create `tests/unit/github-subissues.test.ts`:
```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/github-subissues.test.ts`
Expected: FAIL with "getIssueParent is not a function"

**Step 3: Write minimal implementation**

Add to `src/services/github.ts`:
```typescript
export interface IssueParent {
  number: number;
  state: 'open' | 'closed';
}

// In GitHubService class:
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

    if (response.data.parent) {
      return {
        number: response.data.parent.number,
        state: response.data.parent.state as 'open' | 'closed',
      };
    }
    return null;
  } catch {
    // Graceful degradation - sub-issues API may not be available
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/github-subissues.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/github.ts tests/unit/github-subissues.test.ts
git commit -m "feat: add sub-issues API to GitHub service"
```

---

## Task 6: Add PR Status API to GitHub Service

**Files:**
- Modify: `src/services/github.ts`

**Step 1: Write the failing test**

Create `tests/unit/github-pr-status.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../../src/services/github.js';

describe('GitHubService PR Status', () => {
  let github: GitHubService;
  let mockOctokit: any;

  beforeEach(() => {
    mockOctokit = {
      pulls: { get: vi.fn() },
      checks: { listForRef: vi.fn() },
      request: vi.fn(),
    };
    github = new GitHubService({ token: 'test-token' });
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
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/github-pr-status.test.ts`
Expected: FAIL with "getPrStatus is not a function"

**Step 3: Write minimal implementation**

Add to `src/services/github.ts`:
```typescript
import type { PrStatus, CheckStatus } from '../models/pr-status.js';

// In GitHubService class:
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
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/github-pr-status.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/github.ts tests/unit/github-pr-status.test.ts
git commit -m "feat: add PR status API to GitHub service"
```

---

## Task 7: Create get_pr_status Tool

**Files:**
- Create: `src/tools/get-pr-status.ts`
- Modify: `src/index.ts`

**Step 1: Write the tool implementation**

Create `src/tools/get-pr-status.ts`:
```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getLogger } from '../services/logging.js';

function parseRepository(repository: string): { owner: string; repo: string } | null {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function registerGetPrStatusTool(server: McpServer) {
  server.tool(
    'get_pr_status',
    'Check CI status, approval state, and merge state of a pull request',
    {
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .describe("Repository in 'owner/repo' format"),
      prNumber: z
        .number()
        .int()
        .positive()
        .describe('Pull request number to check'),
    },
    async (args) => {
      const logger = getLogger();
      const github = getGitHubService();

      const parsed = parseRepository(args.repository);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid repository format' }) }],
          isError: true,
        };
      }

      try {
        const status = await github.getPrStatus(parsed.owner, parsed.repo, args.prNumber);

        await logger.info('get_pr_status', {
          repoFullName: args.repository,
          metadata: { prNumber: args.prNumber, state: status.state },
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...status }) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('get_pr_status', errorMessage, { repoFullName: args.repository });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: errorMessage }) }],
          isError: true,
        };
      }
    }
  );
}
```

**Step 2: Register the tool**

Add to `src/index.ts`:
```typescript
import { registerGetPrStatusTool } from './tools/get-pr-status.js';

// In main():
registerGetPrStatusTool(server);
```

**Step 3: Build and verify**

Run: `npm run build && npm run lint`
Expected: No errors

**Step 4: Commit**

```bash
git add src/tools/get-pr-status.ts src/index.ts
git commit -m "feat: add get_pr_status tool"
```

---

## Task 8: Create bulk_update_issues Tool

**Files:**
- Create: `src/tools/bulk-update-issues.ts`
- Modify: `src/index.ts`

**Step 1: Write the tool implementation**

Create `src/tools/bulk-update-issues.ts`:
```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getLogger } from '../services/logging.js';

function parseRepository(repository: string): { owner: string; repo: string } | null {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function registerBulkUpdateIssuesTool(server: McpServer) {
  server.tool(
    'bulk_update_issues',
    'Add/remove labels and close/reopen multiple issues at once',
    {
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .describe("Repository in 'owner/repo' format"),
      issues: z
        .array(z.number().int().positive())
        .min(1)
        .max(50)
        .describe('Issue numbers to update'),
      addLabels: z
        .array(z.string())
        .optional()
        .describe('Labels to add to all issues'),
      removeLabels: z
        .array(z.string())
        .optional()
        .describe('Labels to remove from all issues'),
      state: z
        .enum(['open', 'closed'])
        .optional()
        .describe('Set issue state'),
    },
    async (args) => {
      const logger = getLogger();
      const github = getGitHubService();

      const parsed = parseRepository(args.repository);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid repository format' }) }],
          isError: true,
        };
      }

      const { owner, repo } = parsed;
      const updated: number[] = [];
      const failed: Array<{ issue: number; error: string }> = [];

      for (const issueNumber of args.issues) {
        try {
          // Update labels
          if (args.addLabels?.length || args.removeLabels?.length) {
            await github.updateIssueLabel(
              owner,
              repo,
              issueNumber,
              args.addLabels ?? [],
              args.removeLabels ?? []
            );
          }

          // Update state
          if (args.state) {
            await github.updateIssueState(owner, repo, issueNumber, args.state);
          }

          updated.push(issueNumber);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          failed.push({ issue: issueNumber, error: errorMessage });
        }
      }

      await logger.info('bulk_update_issues', {
        repoFullName: args.repository,
        metadata: { total: args.issues.length, succeeded: updated.length, failed: failed.length },
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: failed.length === 0,
            updated,
            failed,
            summary: {
              total: args.issues.length,
              succeeded: updated.length,
              failed: failed.length,
            },
          }),
        }],
      };
    }
  );
}
```

**Step 2: Add updateIssueState to GitHub service**

Add to `src/services/github.ts`:
```typescript
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
}
```

**Step 3: Register the tool**

Add to `src/index.ts`:
```typescript
import { registerBulkUpdateIssuesTool } from './tools/bulk-update-issues.js';

// In main():
registerBulkUpdateIssuesTool(server);
```

**Step 4: Build and verify**

Run: `npm run build && npm run lint`
Expected: No errors

**Step 5: Commit**

```bash
git add src/tools/bulk-update-issues.ts src/services/github.ts src/index.ts
git commit -m "feat: add bulk_update_issues tool"
```

---

## Task 9: Create Batch Service

**Files:**
- Create: `src/services/batch.ts`
- Modify: `src/services/index.ts`

**Step 1: Write the failing test**

Create `tests/unit/batch.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { BatchService } from '../../src/services/batch.js';

describe('BatchService', () => {
  let batchService: BatchService;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `batch-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    batchService = new BatchService(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('createBatch', () => {
    it('creates and persists batch state', async () => {
      const batch = await batchService.createBatch('owner/repo', [1, 2, 3]);

      expect(batch.repository).toBe('owner/repo');
      expect(batch.queue).toEqual([1, 2, 3]);
      expect(batch.totalCount).toBe(3);

      const retrieved = await batchService.getBatch(batch.batchId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.batchId).toBe(batch.batchId);
    });
  });

  describe('startNextIssue', () => {
    it('pops issue from queue and sets as current', async () => {
      const batch = await batchService.createBatch('owner/repo', [1, 2, 3]);

      const issueNumber = await batchService.startNextIssue(batch.batchId);

      expect(issueNumber).toBe(1);

      const updated = await batchService.getBatch(batch.batchId);
      expect(updated?.currentIssue).toBe(1);
      expect(updated?.queue).toEqual([2, 3]);
    });

    it('returns null when queue is empty', async () => {
      const batch = await batchService.createBatch('owner/repo', []);

      const issueNumber = await batchService.startNextIssue(batch.batchId);

      expect(issueNumber).toBeNull();
    });
  });

  describe('completeCurrentIssue', () => {
    it('moves current issue to completed', async () => {
      const batch = await batchService.createBatch('owner/repo', [1, 2]);
      await batchService.startNextIssue(batch.batchId);
      await batchService.setPrNumber(batch.batchId, 100);

      await batchService.completeCurrentIssue(batch.batchId);

      const updated = await batchService.getBatch(batch.batchId);
      expect(updated?.completedCount).toBe(1);
      expect(updated?.completed).toHaveLength(1);
      expect(updated?.completed[0].issue).toBe(1);
      expect(updated?.completed[0].pr).toBe(100);
      expect(updated?.currentIssue).toBeNull();
      expect(updated?.currentPr).toBeNull();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/batch.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `src/services/batch.ts`:
```typescript
import { readFile, writeFile, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import {
  type BatchState,
  createBatchState,
  validateBatchState,
} from '../models/batch-state.js';
import { getBatchesDir, ensureDirectories } from '../config/index.js';

export class BatchService {
  private batchesDir: string;

  constructor(batchesDir?: string) {
    this.batchesDir = batchesDir ?? getBatchesDir();
  }

  private getBatchFilePath(batchId: string): string {
    return join(this.batchesDir, `${batchId}.json`);
  }

  async createBatch(repository: string, issueNumbers: number[]): Promise<BatchState> {
    await ensureDirectories();
    const batch = createBatchState(repository, issueNumbers.length, issueNumbers);
    await this.saveBatch(batch);
    return batch;
  }

  async getBatch(batchId: string): Promise<BatchState | null> {
    try {
      const content = await readFile(this.getBatchFilePath(batchId), 'utf-8');
      return validateBatchState(JSON.parse(content));
    } catch {
      return null;
    }
  }

  async saveBatch(batch: BatchState): Promise<void> {
    await writeFile(this.getBatchFilePath(batch.batchId), JSON.stringify(batch, null, 2));
  }

  async startNextIssue(batchId: string): Promise<number | null> {
    const batch = await this.getBatch(batchId);
    if (!batch || batch.queue.length === 0) return null;

    const issueNumber = batch.queue.shift()!;
    batch.currentIssue = issueNumber;
    await this.saveBatch(batch);
    return issueNumber;
  }

  async setPrNumber(batchId: string, prNumber: number): Promise<void> {
    const batch = await this.getBatch(batchId);
    if (!batch) return;

    batch.currentPr = prNumber;
    await this.saveBatch(batch);
  }

  async completeCurrentIssue(batchId: string): Promise<void> {
    const batch = await this.getBatch(batchId);
    if (!batch || !batch.currentIssue || !batch.currentPr) return;

    batch.completed.push({
      issue: batch.currentIssue,
      pr: batch.currentPr,
      startedAt: batch.startedAt,
      mergedAt: new Date().toISOString(),
    });
    batch.completedCount++;
    batch.currentIssue = null;
    batch.currentPr = null;

    if (batch.queue.length === 0) {
      batch.status = 'completed';
    }

    await this.saveBatch(batch);
  }

  async abandonBatch(batchId: string): Promise<void> {
    const batch = await this.getBatch(batchId);
    if (!batch) return;

    batch.status = 'abandoned';
    await this.saveBatch(batch);
  }

  async timeoutBatch(batchId: string): Promise<void> {
    const batch = await this.getBatch(batchId);
    if (!batch) return;

    batch.status = 'timeout';
    await this.saveBatch(batch);
  }
}

let globalBatchService: BatchService | null = null;

export function getBatchService(): BatchService {
  if (!globalBatchService) {
    globalBatchService = new BatchService();
  }
  return globalBatchService;
}

export function resetBatchService(): void {
  globalBatchService = null;
}
```

Update `src/services/index.ts`:
```typescript
export * from './batch.js';
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/batch.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/batch.ts src/services/index.ts tests/unit/batch.test.ts
git commit -m "feat: add batch service for managing batch state"
```

---

## Task 10: Create implement_batch Tool

**Files:**
- Create: `src/tools/implement-batch.ts`
- Modify: `src/index.ts`

**Step 1: Write the tool implementation**

Create `src/tools/implement-batch.ts`:
```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getBatchService } from '../services/batch.js';
import { getLogger } from '../services/logging.js';
import { filterAndScoreIssues } from '../services/priority.js';

function parseRepository(repository: string): { owner: string; repo: string } | null {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function registerImplementBatchTool(server: McpServer) {
  server.tool(
    'implement_batch',
    'Start implementing a batch of N issues in priority order. Returns the first issue to implement.',
    {
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .describe("Repository in 'owner/repo' format"),
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe('Number of issues to implement'),
      includeTypes: z
        .array(z.enum(['bug', 'feature', 'chore', 'docs']))
        .optional()
        .describe('Only include these issue types'),
      maxPriority: z
        .enum(['P0', 'P1', 'P2', 'P3'])
        .optional()
        .describe('Only include issues at or above this priority'),
    },
    async (args) => {
      const logger = getLogger();
      const github = getGitHubService();
      const batchService = getBatchService();

      const parsed = parseRepository(args.repository);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid repository format' }) }],
          isError: true,
        };
      }

      const { owner, repo } = parsed;

      try {
        // Get prioritized issues
        const allIssues = await github.listOpenIssues(owner, repo);
        const scoredIssues = filterAndScoreIssues(allIssues, {
          includeTypes: args.includeTypes,
        });

        // Filter by max priority if specified
        let eligibleIssues = scoredIssues;
        if (args.maxPriority) {
          const priorityOrder = ['P0', 'P1', 'P2', 'P3'];
          const maxIndex = priorityOrder.indexOf(args.maxPriority);
          eligibleIssues = scoredIssues.filter(({ issue }) => {
            const priorityLabel = issue.labels.find((l) => l.name.startsWith('priority:'));
            if (!priorityLabel) return false;
            const priority = priorityLabel.name.replace('priority:', '').toUpperCase();
            const priorityIndex = priorityOrder.indexOf(priority);
            return priorityIndex <= maxIndex;
          });
        }

        if (eligibleIssues.length === 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ action: 'empty', reason: 'No issues match criteria' }),
            }],
          };
        }

        // Create batch with top N issues
        const issueNumbers = eligibleIssues.slice(0, args.count).map((s) => s.issue.number);
        const batch = await batchService.createBatch(args.repository, issueNumbers);

        // Start first issue
        const firstIssueNumber = await batchService.startNextIssue(batch.batchId);
        const firstIssue = eligibleIssues.find((s) => s.issue.number === firstIssueNumber)!;

        await logger.info('implement_batch', {
          repoFullName: args.repository,
          metadata: { batchId: batch.batchId, count: issueNumbers.length },
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              action: 'implement',
              batchId: batch.batchId,
              progress: { current: 1, total: batch.totalCount },
              issue: {
                number: firstIssue.issue.number,
                title: firstIssue.issue.title,
                body: firstIssue.issue.body,
                html_url: firstIssue.issue.html_url,
                priority: firstIssue.score.basePoints,
              },
              instructions: `Implement issue #${firstIssue.issue.number}: ${firstIssue.issue.title}. Create a PR when ready, then call batch_continue with the PR number.`,
            }),
          }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('implement_batch', errorMessage, { repoFullName: args.repository });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: errorMessage }) }],
          isError: true,
        };
      }
    }
  );
}
```

**Step 2: Register the tool**

Add to `src/index.ts`:
```typescript
import { registerImplementBatchTool } from './tools/implement-batch.js';

// In main():
registerImplementBatchTool(server);
```

**Step 3: Build and verify**

Run: `npm run build && npm run lint`
Expected: No errors

**Step 4: Commit**

```bash
git add src/tools/implement-batch.ts src/index.ts
git commit -m "feat: add implement_batch tool"
```

---

## Task 11: Create batch_continue Tool

**Files:**
- Create: `src/tools/batch-continue.ts`
- Modify: `src/index.ts`

**Step 1: Write the tool implementation**

Create `src/tools/batch-continue.ts`:
```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getBatchService } from '../services/batch.js';
import { getLogger } from '../services/logging.js';
import { isPrReadyToMerge } from '../models/pr-status.js';

function parseRepository(repository: string): { owner: string; repo: string } | null {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const MAX_POLL_DURATION_MS = 30 * 60_000; // 30 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerBatchContinueTool(server: McpServer) {
  server.tool(
    'batch_continue',
    'Continue batch implementation. Polls for PR merge, then returns next issue or completion.',
    {
      batchId: z.string().uuid().describe('Batch ID from implement_batch'),
      prNumber: z.number().int().positive().optional().describe('PR number for the current issue'),
    },
    async (args) => {
      const logger = getLogger();
      const github = getGitHubService();
      const batchService = getBatchService();

      const batch = await batchService.getBatch(args.batchId);
      if (!batch) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Batch not found' }) }],
          isError: true,
        };
      }

      const parsed = parseRepository(batch.repository);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid repository' }) }],
          isError: true,
        };
      }

      const { owner, repo } = parsed;

      // Set PR number if provided
      if (args.prNumber) {
        await batchService.setPrNumber(args.batchId, args.prNumber);
      }

      const currentBatch = await batchService.getBatch(args.batchId);
      if (!currentBatch?.currentPr) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No PR number set. Provide prNumber argument.' }) }],
          isError: true,
        };
      }

      // Poll for PR merge
      const startTime = Date.now();
      while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
        try {
          const status = await github.getPrStatus(owner, repo, currentBatch.currentPr);

          if (status.state === 'merged') {
            // PR merged - complete current issue and get next
            await batchService.completeCurrentIssue(args.batchId);

            const updatedBatch = await batchService.getBatch(args.batchId);

            if (updatedBatch?.status === 'completed' || updatedBatch?.queue.length === 0) {
              await logger.info('batch_continue', {
                repoFullName: batch.repository,
                metadata: { batchId: args.batchId, action: 'complete' },
              });

              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    action: 'complete',
                    summary: {
                      total: updatedBatch.totalCount,
                      completed: updatedBatch.completedCount,
                      issues: updatedBatch.completed,
                    },
                  }),
                }],
              };
            }

            // Get next issue
            const nextIssueNumber = await batchService.startNextIssue(args.batchId);
            if (!nextIssueNumber) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ action: 'complete', summary: { total: updatedBatch?.totalCount } }) }],
              };
            }

            const allIssues = await github.listOpenIssues(owner, repo);
            const nextIssue = allIssues.find((i) => i.number === nextIssueNumber);

            await logger.info('batch_continue', {
              repoFullName: batch.repository,
              metadata: { batchId: args.batchId, nextIssue: nextIssueNumber },
            });

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  action: 'implement',
                  batchId: args.batchId,
                  progress: { current: (updatedBatch?.completedCount ?? 0) + 1, total: updatedBatch?.totalCount },
                  issue: nextIssue ? {
                    number: nextIssue.number,
                    title: nextIssue.title,
                    body: nextIssue.body,
                    html_url: nextIssue.html_url,
                  } : { number: nextIssueNumber },
                  instructions: `Implement issue #${nextIssueNumber}. Create a PR when ready, then call batch_continue with the PR number.`,
                }),
              }],
            };
          }

          // Check if ready to merge (CI passing, approved)
          if (isPrReadyToMerge(status) && status.state !== 'merged') {
            // PR is ready but not merged yet - keep polling
          }

        } catch (error) {
          // Log error but continue polling
          await logger.error('batch_continue', `Poll error: ${error}`, { repoFullName: batch.repository });
        }

        await sleep(POLL_INTERVAL_MS);
      }

      // Timeout
      await batchService.timeoutBatch(args.batchId);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            action: 'timeout',
            issue: currentBatch.currentIssue,
            prNumber: currentBatch.currentPr,
            message: 'Timed out waiting for PR to merge. Call batch_continue to resume polling.',
          }),
        }],
      };
    }
  );
}
```

**Step 2: Register the tool**

Add to `src/index.ts`:
```typescript
import { registerBatchContinueTool } from './tools/batch-continue.js';

// In main():
registerBatchContinueTool(server);
```

**Step 3: Build and verify**

Run: `npm run build && npm run lint`
Expected: No errors

**Step 4: Commit**

```bash
git add src/tools/batch-continue.ts src/index.ts
git commit -m "feat: add batch_continue tool with PR polling"
```

---

## Task 12: Create get_workflow_analytics Tool

**Files:**
- Create: `src/tools/get-workflow-analytics.ts`
- Modify: `src/index.ts`

**Step 1: Write the tool implementation**

Create `src/tools/get-workflow-analytics.ts`:
```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getWorkflowService } from '../services/workflow.js';
import { getLogger } from '../services/logging.js';
import type { WorkflowState, WorkflowPhase } from '../models/workflow-state.js';

const PHASE_ORDER: WorkflowPhase[] = [
  'selection', 'research', 'branch', 'implementation',
  'testing', 'commit', 'pr', 'review', 'merged'
];

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function calculatePhaseTime(state: WorkflowState, phase: WorkflowPhase): number | null {
  const history = state.phaseHistory;
  const enterTransition = history.find((t) => t.to === phase);
  const exitTransition = history.find((t) => t.from === phase && t.to !== phase);

  if (!enterTransition) return null;

  const enterTime = new Date(enterTransition.timestamp).getTime();
  const exitTime = exitTransition
    ? new Date(exitTransition.timestamp).getTime()
    : Date.now();

  return exitTime - enterTime;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export function registerGetWorkflowAnalyticsTool(server: McpServer) {
  server.tool(
    'get_workflow_analytics',
    'Get time-based workflow analytics: cycle time, phase breakdown, aging reports',
    {
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .describe("Repository in 'owner/repo' format"),
      period: z
        .enum(['7d', '30d', '90d', 'all'])
        .default('30d')
        .describe('Time period for analytics'),
    },
    async (args) => {
      const logger = getLogger();
      const workflowService = getWorkflowService();

      const periodMs: Record<string, number> = {
        '7d': 7 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000,
        '90d': 90 * 24 * 60 * 60 * 1000,
        'all': Infinity,
      };

      const cutoffTime = Date.now() - periodMs[args.period];
      const allStates = await workflowService.listWorkflowStates();

      // Filter by repository and period
      const states = allStates.filter((s) => {
        if (s.repoFullName !== args.repository) return false;
        const startTime = new Date(s.phaseHistory[0]?.timestamp ?? 0).getTime();
        return startTime >= cutoffTime;
      });

      const completed = states.filter((s) => s.currentPhase === 'merged');
      const abandoned = states.filter((s) => s.currentPhase === 'abandoned');
      const inProgress = states.filter((s) => !['merged', 'abandoned'].includes(s.currentPhase));

      // Calculate cycle times for completed issues
      const cycleTimes = completed.map((s) => {
        const start = new Date(s.phaseHistory[0]?.timestamp ?? 0).getTime();
        const end = new Date(s.phaseHistory[s.phaseHistory.length - 1]?.timestamp ?? 0).getTime();
        return end - start;
      });

      // Calculate phase breakdown
      const phaseBreakdown: Record<string, { average: string; median: string }> = {};
      for (const phase of PHASE_ORDER.filter((p) => p !== 'merged' && p !== 'abandoned')) {
        const times = completed
          .map((s) => calculatePhaseTime(s, phase))
          .filter((t): t is number => t !== null);

        if (times.length > 0) {
          phaseBreakdown[phase] = {
            average: formatDuration(average(times)),
            median: formatDuration(median(times)),
          };
        }
      }

      // Calculate aging for in-progress issues
      const now = Date.now();
      const aging = inProgress.map((s) => {
        const start = new Date(s.phaseHistory[0]?.timestamp ?? 0).getTime();
        const ageMs = now - start;
        return {
          issue: s.issueNumber,
          age: formatDuration(ageMs),
          ageMs,
          lastPhase: s.currentPhase,
        };
      }).sort((a, b) => b.ageMs - a.ageMs);

      const stale = aging.filter((a) => a.ageMs > 14 * 24 * 60 * 60 * 1000);
      const oldest = aging[0] ?? null;

      const periodStart = new Date(cutoffTime).toISOString().split('T')[0];
      const periodEnd = new Date().toISOString().split('T')[0];

      await logger.info('get_workflow_analytics', {
        repoFullName: args.repository,
        metadata: { period: args.period, completed: completed.length },
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            period: { start: periodStart, end: periodEnd },
            cycleTime: cycleTimes.length > 0 ? {
              average: formatDuration(average(cycleTimes)),
              median: formatDuration(median(cycleTimes)),
              p90: formatDuration(percentile(cycleTimes, 90)),
            } : null,
            phaseBreakdown,
            issuesCompleted: completed.length,
            issuesAbandoned: abandoned.length,
            issuesInProgress: inProgress.length,
            aging: {
              oldest: oldest ? { issue: oldest.issue, age: oldest.age, lastPhase: oldest.lastPhase } : null,
              stale: stale.map((s) => ({ issue: s.issue, age: s.age, lastPhase: s.lastPhase })),
            },
          }),
        }],
      };
    }
  );
}
```

**Step 2: Register the tool**

Add to `src/index.ts`:
```typescript
import { registerGetWorkflowAnalyticsTool } from './tools/get-workflow-analytics.js';

// In main():
registerGetWorkflowAnalyticsTool(server);
```

**Step 3: Build and verify**

Run: `npm run build && npm run lint`
Expected: No errors

**Step 4: Commit**

```bash
git add src/tools/get-workflow-analytics.ts src/index.ts
git commit -m "feat: add get_workflow_analytics tool"
```

---

## Task 13: Update list_backlog to Show Blocked Status

**Files:**
- Modify: `src/tools/list-backlog.ts`
- Modify: `src/services/priority.ts`

**Step 1: Update priority service to accept dependency info**

Update `src/services/priority.ts`:
```typescript
export interface DependencyInfo {
  issueNumber: number;
  blockedByIssue: number | null;
}

export function scoreIssuesWithDependencies(
  issues: Issue[],
  dependencies: Map<number, number | null>
): ScoredIssue[] {
  return issues.map((issue) => {
    const blockedByIssue = dependencies.get(issue.number) ?? null;
    return {
      issue,
      score: calculatePriorityScore(issue, { blockedByIssue }),
      ageInDays: calculateAgeInDays(issue.created_at),
      blockedByIssue,
    };
  });
}
```

Update `ScoredIssue` interface:
```typescript
export interface ScoredIssue {
  issue: Issue;
  score: PriorityScore;
  ageInDays: number;
  blockedByIssue?: number | null;
}
```

**Step 2: Update list_backlog tool**

Update `src/tools/list-backlog.ts` to fetch and display blocked status:

In the handler, after fetching issues:
```typescript
// Fetch dependency info for all issues
const dependencies = new Map<number, number | null>();
for (const issue of allIssues) {
  const parent = await github.getIssueParent(owner, repo, issue.number);
  if (parent && parent.state === 'open') {
    dependencies.set(issue.number, parent.number);
  }
}

// Score with dependencies
const scoredIssues = scoreIssuesWithDependencies(
  applyFilters(allIssues, { includeTypes: args.includeTypes, excludeTypes: args.excludeTypes }),
  dependencies
);
scoredIssues.sort((a, b) => comparePriorityScores(a.score, b.score));
```

Update the backlog item mapping to include blocked info:
```typescript
const backlog = scoredIssues.slice(0, limit).map(({ issue, score, ageInDays, blockedByIssue }) => ({
  number: issue.number,
  title: issue.title,
  priority: priorityLabel?.replace('priority:', '') ?? null,
  type: typeLabel?.replace('type:', '') ?? null,
  priorityScore: score.totalScore,
  ageInDays,
  isLocked,
  lockedBy: isLocked ? lockHolders.get(issue.number) ?? null : null,
  blockedBy: blockedByIssue ?? null,
}));
```

**Step 3: Build and verify**

Run: `npm run build && npm run lint && npm test`
Expected: All pass

**Step 4: Commit**

```bash
git add src/tools/list-backlog.ts src/services/priority.ts
git commit -m "feat: show blocked status in list_backlog"
```

---

## Task 14: Update select_next_issue to Apply Blocked Penalty

**Files:**
- Modify: `src/tools/select-next-issue.ts`

**Step 1: Update to use dependency-aware scoring**

The changes mirror Task 13 - fetch dependencies and use `scoreIssuesWithDependencies`.

**Step 2: Build and verify**

Run: `npm run build && npm run lint && npm test`
Expected: All pass

**Step 3: Commit**

```bash
git add src/tools/select-next-issue.ts
git commit -m "feat: apply blocked penalty in select_next_issue"
```

---

## Task 15: Update README with New Tools

**Files:**
- Modify: `README.md`

**Step 1: Add documentation for new tools**

Add sections for:
- `implement_batch`
- `batch_continue`
- `get_pr_status`
- `bulk_update_issues`
- `get_workflow_analytics`

Document the dependency/blocked feature.

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add documentation for new tools"
```

---

## Task 16: Run Full Test Suite and Lint

**Step 1: Run all checks**

```bash
npm run build && npm run lint && npm test
```

Expected: All pass

**Step 2: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address any remaining issues"
```

---

## Task 17: Merge to Main

**Step 1: Push feature branch**

```bash
git push -u origin feature/batch-deps-analytics
```

**Step 2: Create PR or merge**

```bash
# If merging directly:
git checkout main
git merge feature/batch-deps-analytics
git push origin main

# Clean up worktree
git worktree remove .worktrees/batch-deps-analytics
```
