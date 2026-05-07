# Cache Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a file-based cache layer to `GitHubService` that reduces GitHub API calls across parallel, frequently-restarting MCP sessions — using delta fetches (only issues modified since last check) and atomic writes (tmp → rename) to prevent file corruption.

**Architecture:** A new `CacheService` singleton handles all disk I/O using atomic writes. `GitHubService` calls through it on reads (issues, labels, PR status) and invalidates entries after writes. Tools are unchanged — cache is transparent to them. Issues use delta fetch (`filterBy: { since: lastModifiedAt }`); labels use TTL (1 hour); open PR status uses TTL (60 s); terminal PR states never expire.

**Tech Stack:** Node.js built-ins only (`fs/promises`, `crypto.randomUUID`, `path`, `os`) — no new dependencies.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/config/index.ts` | Modify | Add `getCacheDir()`, `cacheDir` to Config, `ensureDirectories` |
| `src/services/github-graphql.ts` | Modify | Add `LIST_ISSUES_DELTA_QUERY`, `GQLListIssuesDeltaResponse` |
| `src/services/cache.ts` | **Create** | `CacheService` class + singleton accessors |
| `src/services/github.ts` | Modify | Inject `CacheService`; add reads, delta merge, invalidations |
| `src/services/index.ts` | Modify | Re-export `cache.ts` exports |
| `src/index.ts` | Modify | Call `initializeCacheService()` at startup |
| `tests/unit/cache.test.ts` | **Create** | Unit tests for `CacheService` |
| `tests/unit/github-cache.test.ts` | **Create** | Integration tests for `GitHubService` cache reads + invalidations |
| `tests/unit/github-graphql.test.ts` | Modify | Inject null cache to prevent disk pollution |
| `tests/unit/github-pr-status.test.ts` | Modify | Inject null cache to prevent disk pollution |
| `tests/unit/github-ensure-labels.test.ts` | Modify | Inject null cache to prevent disk pollution |
| `tests/unit/github-subissues.test.ts` | Modify | Inject null cache to prevent disk pollution |

---

## Task 1: Config cache dir + GraphQL delta query

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/services/github-graphql.ts`
- Modify: `tests/unit/config.test.ts`

- [ ] **Step 1: Write failing test for `getCacheDir`**

Add to `tests/unit/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getBatchesDir, getCacheDir } from '../../src/config/index.js';
import { homedir } from 'os';
import { join } from 'path';

describe('Config', () => {
  describe('getBatchesDir', () => {
    it('returns correct batches directory path', () => {
      const expected = join(homedir(), '.mcp-git-issue-priority', 'batches');
      expect(getBatchesDir()).toBe(expected);
    });
  });

  describe('getCacheDir', () => {
    it('returns correct cache directory path', () => {
      const expected = join(homedir(), '.mcp-git-issue-priority', 'cache');
      expect(getCacheDir()).toBe(expected);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/config.test.ts 2>&1 | tail -20
```

Expected: FAIL — `getCacheDir is not a function` or import error.

- [ ] **Step 3: Add `getCacheDir` to config**

In `src/config/index.ts`, add `getCacheDir` after `getBatchesDir`:

```typescript
export function getCacheDir(): string {
  return join(getBaseDir(), 'cache');
}
```

Update the `Config` interface to include `cacheDir`:

```typescript
export interface Config {
  baseDir: string;
  locksDir: string;
  workflowDir: string;
  logsDir: string;
  cacheDir: string;
  githubToken: string;
  sessionId: string;
  defaultRepository?: { owner: string; repo: string };
}
```

Update `createConfig` return value to include `cacheDir`:

```typescript
  return {
    baseDir: getBaseDir(),
    locksDir: getLocksDir(),
    workflowDir: getWorkflowDir(),
    logsDir: getLogsDir(),
    cacheDir: getCacheDir(),
    githubToken: token,
    sessionId: generateSessionId(),
    defaultRepository: getDefaultRepository(),
  };
```

Update `ensureDirectories` to include the cache dir:

```typescript
export async function ensureDirectories(): Promise<void> {
  const dirs = [getBaseDir(), getLocksDir(), getWorkflowDir(), getLogsDir(), getBatchesDir(), getCacheDir()];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/config.test.ts 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 5: Add `LIST_ISSUES_DELTA_QUERY` to `src/services/github-graphql.ts`**

Add after `LIST_ISSUES_QUERY`:

```typescript
export const LIST_ISSUES_DELTA_QUERY = `
  query ListUpdatedIssues($owner: String!, $repo: String!, $since: DateTime!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $cursor, filterBy: { since: $since }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          body
          state
          url
          createdAt
          updatedAt
          labels(first: 20) { nodes { name color description } }
          assignees(first: 10) { nodes { login } }
          parent { number state }
        }
      }
    }
  }
`;

// Delta response has identical shape to the full query — nodes include state: OPEN | CLOSED
export type GQLListIssuesDeltaResponse = GQLListIssuesResponse;
```

- [ ] **Step 6: Run full test suite to confirm no regressions**

```bash
npm test 2>&1 | tail -20
```

Expected: all existing tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config/index.ts src/services/github-graphql.ts tests/unit/config.test.ts
git commit -m "feat(cache): add getCacheDir config + GraphQL delta query"
```

---

## Task 2: Implement `CacheService`

**Files:**
- Create: `src/services/cache.ts`
- Create: `tests/unit/cache.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { CacheService, type CachedIssues } from '../../src/services/cache.js';
import type { Issue } from '../../src/models/index.js';
import type { PrStatus } from '../../src/models/index.js';

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

const makeOpenPrStatus = (prNumber = 1): PrStatus => ({
  prNumber,
  state: 'open',
  mergeable: true,
  ci: { status: 'passing', checks: [] },
  reviews: { approved: false, changesRequested: false, reviewers: [] },
  autoMerge: { enabled: false },
});

const makeMergedPrStatus = (prNumber = 1): PrStatus => ({
  ...makeOpenPrStatus(prNumber),
  state: 'merged',
  mergeable: null,
});

describe('CacheService', () => {
  let tmpDir: string;
  let cache: CacheService;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `cache-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    cache = new CacheService(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- issues ---

  describe('getIssues', () => {
    it('returns null when no cache file exists', async () => {
      expect(await cache.getIssues('owner', 'repo')).toBeNull();
    });

    it('returns cached data when fresh', async () => {
      const data: CachedIssues = { issues: [makeIssue(1)], dependencies: [[1, null]] };
      await cache.setIssues('owner', 'repo', data, '2026-05-06T12:00:00.000Z');

      const result = await cache.getIssues('owner', 'repo');

      expect(result).not.toBeNull();
      expect(result!.data.issues).toHaveLength(1);
      expect(result!.data.issues[0].number).toBe(1);
      expect(result!.data.dependencies).toEqual([[1, null]]);
      expect(result!.lastModifiedAt).toBe('2026-05-06T12:00:00.000Z');
    });

    it('returns null when cache is older than 24 hours', async () => {
      await cache.setIssues('owner', 'repo', { issues: [], dependencies: [] }, '2026-05-05T00:00:00.000Z');

      const filePath = join(tmpDir, 'owner__repo', 'issues.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      raw.fetchedAt = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      await writeFile(filePath, JSON.stringify(raw), 'utf-8');

      expect(await cache.getIssues('owner', 'repo')).toBeNull();
    });

    it('returns null and does not throw when file is corrupt JSON', async () => {
      const dir = join(tmpDir, 'owner__repo');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'issues.json'), 'NOT VALID JSON', 'utf-8');

      expect(await cache.getIssues('owner', 'repo')).toBeNull();
    });
  });

  describe('setIssues', () => {
    it('writes atomically — no leftover .tmp files after write', async () => {
      await cache.setIssues('owner', 'repo', { issues: [], dependencies: [] }, '2026-05-06T00:00:00.000Z');

      const dir = join(tmpDir, 'owner__repo');
      const files = await readdir(dir);
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));

      expect(tmpFiles).toHaveLength(0);
      expect(files).toContain('issues.json');
    });
  });

  describe('invalidateIssues', () => {
    it('deletes the cache file', async () => {
      await cache.setIssues('owner', 'repo', { issues: [], dependencies: [] }, '2026-05-06T00:00:00.000Z');
      await cache.invalidateIssues('owner', 'repo');

      expect(await cache.getIssues('owner', 'repo')).toBeNull();
    });

    it('does not throw when file does not exist', async () => {
      await expect(cache.invalidateIssues('owner', 'repo')).resolves.not.toThrow();
    });
  });

  // --- labels ---

  describe('getLabels', () => {
    it('returns null when no cache file exists', async () => {
      expect(await cache.getLabels('owner', 'repo')).toBeNull();
    });

    it('returns cached labels when within TTL', async () => {
      await cache.setLabels('owner', 'repo', ['priority:high', 'type:bug']);

      expect(await cache.getLabels('owner', 'repo')).toEqual(['priority:high', 'type:bug']);
    });

    it('returns null when TTL has expired', async () => {
      await cache.setLabels('owner', 'repo', ['priority:high']);

      const filePath = join(tmpDir, 'owner__repo', 'labels.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      raw.fetchedAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      await writeFile(filePath, JSON.stringify(raw), 'utf-8');

      expect(await cache.getLabels('owner', 'repo')).toBeNull();
    });
  });

  describe('invalidateLabels', () => {
    it('deletes the labels cache file', async () => {
      await cache.setLabels('owner', 'repo', ['priority:high']);
      await cache.invalidateLabels('owner', 'repo');

      expect(await cache.getLabels('owner', 'repo')).toBeNull();
    });

    it('does not throw when file does not exist', async () => {
      await expect(cache.invalidateLabels('owner', 'repo')).resolves.not.toThrow();
    });
  });

  // --- PR status ---

  describe('getPrStatus', () => {
    it('returns null when no cache file exists', async () => {
      expect(await cache.getPrStatus('owner', 'repo', 1)).toBeNull();
    });

    it('returns cached status for open PR within TTL', async () => {
      const status = makeOpenPrStatus(42);
      await cache.setPrStatus('owner', 'repo', 42, status);

      expect(await cache.getPrStatus('owner', 'repo', 42)).toEqual(status);
    });

    it('returns null for open PR when TTL has expired', async () => {
      await cache.setPrStatus('owner', 'repo', 1, makeOpenPrStatus());

      const filePath = join(tmpDir, 'owner__repo', 'pr-1.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      raw.fetchedAt = Date.now() - 120_000; // 2 minutes ago
      await writeFile(filePath, JSON.stringify(raw), 'utf-8');

      expect(await cache.getPrStatus('owner', 'repo', 1)).toBeNull();
    });

    it('returns merged PR status even when fetched a week ago (null TTL = never-expire)', async () => {
      await cache.setPrStatus('owner', 'repo', 1, makeMergedPrStatus());

      const filePath = join(tmpDir, 'owner__repo', 'pr-1.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      raw.fetchedAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
      await writeFile(filePath, JSON.stringify(raw), 'utf-8');

      expect(await cache.getPrStatus('owner', 'repo', 1)).toEqual(makeMergedPrStatus());
    });

    it('stores null TTL for merged PR', async () => {
      await cache.setPrStatus('owner', 'repo', 1, makeMergedPrStatus());

      const filePath = join(tmpDir, 'owner__repo', 'pr-1.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(raw.ttl).toBeNull();
    });

    it('stores numeric TTL for open PR', async () => {
      await cache.setPrStatus('owner', 'repo', 1, makeOpenPrStatus());

      const filePath = join(tmpDir, 'owner__repo', 'pr-1.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(typeof raw.ttl).toBe('number');
      expect(raw.ttl).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/unit/cache.test.ts 2>&1 | tail -20
```

Expected: FAIL — `cache.ts` does not exist.

- [ ] **Step 3: Create `src/services/cache.ts`**

```typescript
import { readFile, writeFile, unlink, mkdir, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { getCacheDir } from '../config/index.js';
import type { Issue } from '../models/index.js';
import type { PrStatus } from '../models/index.js';

const LABELS_TTL_MS = 60 * 60 * 1000;         // 1 hour
const PR_OPEN_TTL_MS = 60 * 1_000;            // 60 seconds
const ISSUES_MAX_AGE_MS = 24 * 60 * 60 * 1_000; // 24 hours → triggers full refresh

interface CacheEnvelope<T> {
  v: 1;
  fetchedAt: number;
  lastModifiedAt?: string;
  ttl: number | null;
  data: T;
}

export interface CachedIssues {
  issues: Issue[];
  dependencies: [number, number | null][];
}

async function readEnvelope<T>(filePath: string): Promise<CacheEnvelope<T> | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (parsed.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isExpired(envelope: CacheEnvelope<unknown>): boolean {
  if (envelope.ttl === null) return false;
  return Date.now() - envelope.fetchedAt > envelope.ttl;
}

async function atomicWrite<T>(filePath: string, envelope: CacheEnvelope<T>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(envelope), 'utf-8');
    await rename(tmp, filePath);
  } catch (err) {
    try { await unlink(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

export class CacheService {
  constructor(private readonly cacheDir: string) {}

  private issuesPath(owner: string, repo: string): string {
    return join(this.cacheDir, `${owner}__${repo}`, 'issues.json');
  }

  private labelsPath(owner: string, repo: string): string {
    return join(this.cacheDir, `${owner}__${repo}`, 'labels.json');
  }

  private prPath(owner: string, repo: string, prNumber: number): string {
    return join(this.cacheDir, `${owner}__${repo}`, `pr-${prNumber}.json`);
  }

  async getIssues(
    owner: string,
    repo: string
  ): Promise<{ data: CachedIssues; lastModifiedAt: string } | null> {
    const envelope = await readEnvelope<CachedIssues>(this.issuesPath(owner, repo));
    if (!envelope) return null;
    if (Date.now() - envelope.fetchedAt > ISSUES_MAX_AGE_MS) return null;
    if (!envelope.lastModifiedAt) return null;
    return { data: envelope.data, lastModifiedAt: envelope.lastModifiedAt };
  }

  async setIssues(
    owner: string,
    repo: string,
    data: CachedIssues,
    lastModifiedAt: string
  ): Promise<void> {
    try {
      await atomicWrite<CachedIssues>(this.issuesPath(owner, repo), {
        v: 1,
        fetchedAt: Date.now(),
        lastModifiedAt,
        ttl: null,
        data,
      });
    } catch (err) {
      console.error(`[cache] setIssues failed: ${(err as Error).message}`);
    }
  }

  async invalidateIssues(owner: string, repo: string): Promise<void> {
    try {
      await unlink(this.issuesPath(owner, repo));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[cache] invalidateIssues failed: ${(err as Error).message}`);
      }
    }
  }

  async getLabels(owner: string, repo: string): Promise<string[] | null> {
    const envelope = await readEnvelope<string[]>(this.labelsPath(owner, repo));
    if (!envelope || isExpired(envelope)) return null;
    return envelope.data;
  }

  async setLabels(owner: string, repo: string, names: string[]): Promise<void> {
    try {
      await atomicWrite<string[]>(this.labelsPath(owner, repo), {
        v: 1,
        fetchedAt: Date.now(),
        ttl: LABELS_TTL_MS,
        data: names,
      });
    } catch (err) {
      console.error(`[cache] setLabels failed: ${(err as Error).message}`);
    }
  }

  async invalidateLabels(owner: string, repo: string): Promise<void> {
    try {
      await unlink(this.labelsPath(owner, repo));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[cache] invalidateLabels failed: ${(err as Error).message}`);
      }
    }
  }

  async getPrStatus(owner: string, repo: string, prNumber: number): Promise<PrStatus | null> {
    const envelope = await readEnvelope<PrStatus>(this.prPath(owner, repo, prNumber));
    if (!envelope || isExpired(envelope)) return null;
    return envelope.data;
  }

  async setPrStatus(
    owner: string,
    repo: string,
    prNumber: number,
    status: PrStatus
  ): Promise<void> {
    const isTerminal = status.state === 'merged' || status.state === 'closed';
    try {
      await atomicWrite<PrStatus>(this.prPath(owner, repo, prNumber), {
        v: 1,
        fetchedAt: Date.now(),
        ttl: isTerminal ? null : PR_OPEN_TTL_MS,
        data: status,
      });
    } catch (err) {
      console.error(`[cache] setPrStatus failed: ${(err as Error).message}`);
    }
  }
}

let globalCacheService: CacheService | null = null;

export function getCacheService(): CacheService {
  if (!globalCacheService) {
    globalCacheService = new CacheService(getCacheDir());
  }
  return globalCacheService;
}

export function initializeCacheService(cacheDir?: string): CacheService {
  globalCacheService = new CacheService(cacheDir ?? getCacheDir());
  return globalCacheService;
}

export function resetCacheService(): void {
  globalCacheService = null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/cache.test.ts 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
npm test 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add src/services/cache.ts tests/unit/cache.test.ts
git commit -m "feat(cache): implement CacheService with atomic writes and TTL"
```

---

## Task 3: Wire cache reads into `GitHubService`

**Files:**
- Modify: `src/services/github.ts`
- Create: `tests/unit/github-cache.test.ts`
- Modify: `tests/unit/github-graphql.test.ts`
- Modify: `tests/unit/github-pr-status.test.ts`
- Modify: `tests/unit/github-ensure-labels.test.ts`
- Modify: `tests/unit/github-subissues.test.ts`

- [ ] **Step 1: Write failing tests for cache reads**

Create `tests/unit/github-cache.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../../src/services/github.js';
import { CacheService, type CachedIssues } from '../../src/services/cache.js';
import type { Issue } from '../../src/models/index.js';
import type { PrStatus } from '../../src/models/index.js';

// Shared null-cache factory — every method returns a cache miss
export function makeNullCache(): CacheService {
  return {
    getIssues: vi.fn().mockResolvedValue(null),
    setIssues: vi.fn().mockResolvedValue(undefined),
    invalidateIssues: vi.fn().mockResolvedValue(undefined),
    getLabels: vi.fn().mockResolvedValue(null),
    setLabels: vi.fn().mockResolvedValue(undefined),
    invalidateLabels: vi.fn().mockResolvedValue(undefined),
    getPrStatus: vi.fn().mockResolvedValue(null),
    setPrStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
}

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
    github = new GitHubService({ token: 'test-token', cacheService: mockCache });
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
      // Delta returns a new issue
      mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([makeGQLNode(2)]));

      const { issues } = await github.listOpenIssuesWithParents('owner', 'repo');

      expect(issues).toHaveLength(2); // cached #1 + delta #2
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
      // Delta says issue #1 was closed
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
      // First call (delta) throws; second call (full) succeeds
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
      // Delta: issue #2 still open but parent now closed
      const node2 = { ...makeGQLNode(2), parent: { number: 1, state: 'CLOSED' } };
      mockOctokit.graphql.mockResolvedValueOnce(makeGQLPage([node2]));

      const { dependencies } = await github.listOpenIssuesWithParents('owner', 'repo');

      expect(dependencies.has(2)).toBe(false); // parent closed → removed
    });
  });

  // --- listOpenIssues ---

  describe('listOpenIssues', () => {
    it('returns issues from cache when available (no API call)', async () => {
      const cached: CachedIssues = { issues: [makeIssue(1)], dependencies: [] };
      (mockCache.getIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: cached,
        lastModifiedAt: '2026-01-01T12:00:00.000Z',
      });
      // Delta returns empty — no changes
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/unit/github-cache.test.ts 2>&1 | tail -20
```

Expected: FAIL — `GitHubService` constructor doesn't accept `cacheService` yet.

- [ ] **Step 3: Update `GitHubServiceOptions` and add `cacheService` field**

In `src/services/github.ts`, update the interface and constructor:

```typescript
import type { CacheService } from './cache.js';
import { getCacheService } from './cache.js';

export interface GitHubServiceOptions {
  token: string;
  cacheService?: CacheService;
}

export class GitHubService {
  private octokit: InstanceType<typeof ThrottledOctokit>;
  private cacheService: CacheService;

  constructor(options: GitHubServiceOptions) {
    this.octokit = new ThrottledOctokit({ /* ... unchanged ... */ });
    this.cacheService = options.cacheService ?? getCacheService();
  }
```

- [ ] **Step 4: Extract `mapGQLNodeToIssue` private helper**

In `src/services/github.ts`, extract the GQL-to-Issue mapping from `fetchIssuesGraphQL` into a private method. This is needed by both the existing full-fetch path and the new delta-merge path.

Add this private method to `GitHubService`:

```typescript
  private mapGQLNodeToIssue(
    node: {
      number: number; title: string; body: string | null; state: string;
      url: string; createdAt: string; updatedAt: string;
      labels: { nodes: Array<{ name: string; color: string; description: string | null }> };
      assignees: { nodes: Array<{ login: string }> };
    },
    owner: string,
    repo: string
  ): Issue {
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
```

Then update the mapping in `fetchIssuesGraphQL` to use this helper:

```typescript
    const issues: Issue[] = allNodes.map((node) => this.mapGQLNodeToIssue(node, owner, repo));
```

- [ ] **Step 5: Add `computeLastModifiedAt` and `mergeIssueDelta` private methods**

Add to `GitHubService`:

```typescript
  private computeLastModifiedAt(issues: Issue[]): string {
    if (issues.length === 0) return new Date().toISOString();
    return issues.reduce(
      (max, i) => (i.updated_at > max ? i.updated_at : max),
      issues[0].updated_at
    );
  }

  private mergeIssueDelta(
    owner: string,
    repo: string,
    cached: import('./cache.js').CachedIssues,
    deltaNodes: Array<import('./github-graphql.js').GQLIssueNode>
  ): import('./cache.js').CachedIssues {
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
```

- [ ] **Step 6: Add `fetchDeltaNodes` private method**

```typescript
  private async fetchDeltaNodes(
    owner: string,
    repo: string,
    since: string
  ): Promise<import('./github-graphql.js').GQLIssueNode[]> {
    type OctokitWithGraphQL = { graphql: <T>(query: string, vars?: Record<string, unknown>) => Promise<T> };
    const gql = (this.octokit as unknown as OctokitWithGraphQL).graphql;
    const allNodes: import('./github-graphql.js').GQLIssueNode[] = [];
    let cursor: string | null = null;

    do {
      const result = await gql<import('./github-graphql.js').GQLListIssuesDeltaResponse>(
        LIST_ISSUES_DELTA_QUERY,
        { owner, repo, since, cursor }
      );
      const page = result.repository.issues;
      allNodes.push(...(page.nodes as import('./github-graphql.js').GQLIssueNode[]));
      cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
    } while (cursor);

    return allNodes;
  }
```

Add `LIST_ISSUES_DELTA_QUERY` and `GQLListIssuesDeltaResponse` to the import from `'./github-graphql.js'`.

- [ ] **Step 7: Update `listOpenIssuesWithParents` to use cache + delta**

Replace the existing `listOpenIssuesWithParents` method body with:

```typescript
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

    // Full fetch (cache miss, 24h stale, or delta failure)
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
      {
        issues: result.issues,
        dependencies: [...result.dependencies.entries()],
      },
      lastModifiedAt
    );
    return result;
  }
```

Extract the existing REST fallback from `listOpenIssuesWithParents` into a private `listOpenIssuesFallback` method:

```typescript
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
```

- [ ] **Step 8: Update `listOpenIssues` to serve from issues cache**

Replace `listOpenIssues` body with:

```typescript
  async listOpenIssues(owner: string, repo: string): Promise<Issue[]> {
    const { issues } = await this.listOpenIssuesWithParents(owner, repo);
    return issues;
  }
```

- [ ] **Step 9: Update `ensureLabelsExist` to check labels cache**

Replace the `ensureLabelsExist` method body with:

```typescript
  async ensureLabelsExist(owner: string, repo: string): Promise<void> {
    const allLabels = {
      ...LABEL_DEFINITIONS.priority,
      ...LABEL_DEFINITIONS.type,
      ...LABEL_DEFINITIONS.status,
    };

    // Serve from cache when all required labels are present
    const cached = await this.cacheService.getLabels(owner, repo);
    if (cached) {
      const cachedSet = new Set(cached);
      const allRequired = Object.keys(allLabels).every((name) => cachedSet.has(name));
      if (allRequired) return;
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
```

- [ ] **Step 10: Update `getPrStatus` to check PR cache**

At the top of `getPrStatus`, add a cache check before the GraphQL try block:

```typescript
  async getPrStatus(owner: string, repo: string, prNumber: number): Promise<PrStatus> {
    const cached = await this.cacheService.getPrStatus(owner, repo, prNumber);
    if (cached) return cached;

    try {
      // ... existing GraphQL path unchanged ...
      const status = /* result of GraphQL fetch */;
      await this.cacheService.setPrStatus(owner, repo, prNumber, status);
      return status;
    } catch {
      const status = await this.getPrStatusREST(owner, repo, prNumber);
      await this.cacheService.setPrStatus(owner, repo, prNumber, status);
      return status;
    }
  }
```

The full updated method:

```typescript
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
```

- [ ] **Step 11: Update existing `GitHubService` tests to inject null cache**

In each of the following files, add `import { makeNullCache } from './github-cache.js';` and update `new GitHubService({ token: 'test-token' })` to `new GitHubService({ token: 'test-token', cacheService: makeNullCache() })`:

**`tests/unit/github-graphql.test.ts`** — update `beforeEach`:
```typescript
import { makeNullCache } from './github-cache.js';
// ...
beforeEach(() => {
  mockOctokit = { graphql: vi.fn(), paginate: vi.fn(), issues: { listForRepo: vi.fn() }, request: vi.fn() };
  github = new GitHubService({ token: 'test-token', cacheService: makeNullCache() });
  (github as any).octokit = mockOctokit;
});
```

**`tests/unit/github-pr-status.test.ts`** — update `beforeEach`:
```typescript
import { makeNullCache } from './github-cache.js';
// ...
beforeEach(() => {
  mockOctokit = { pulls: { get: vi.fn() }, checks: { listForRef: vi.fn() }, request: vi.fn() };
  github = new GitHubService({ token: 'test-token', cacheService: makeNullCache() });
  (github as any).octokit = mockOctokit;
});
```

**`tests/unit/github-ensure-labels.test.ts`** — update `beforeEach`:
```typescript
import { makeNullCache } from './github-cache.js';
// ...
beforeEach(() => {
  mockOctokit = { graphql: vi.fn(), issues: { createLabel: vi.fn().mockResolvedValue(undefined) } };
  github = new GitHubService({ token: 'test-token', cacheService: makeNullCache() });
  (github as any).octokit = mockOctokit;
});
```

**`tests/unit/github-subissues.test.ts`** — update `beforeEach` similarly.

- [ ] **Step 12: Run new cache tests to verify they pass**

```bash
npx vitest run tests/unit/github-cache.test.ts 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 13: Run full suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 14: Commit**

```bash
git add src/services/github.ts tests/unit/github-cache.test.ts \
  tests/unit/github-graphql.test.ts tests/unit/github-pr-status.test.ts \
  tests/unit/github-ensure-labels.test.ts tests/unit/github-subissues.test.ts
git commit -m "feat(cache): wire cache reads + delta merge into GitHubService"
```

---

## Task 4: Wire cache invalidations on writes

**Files:**
- Modify: `src/services/github.ts`
- Modify: `tests/unit/github-cache.test.ts`

- [ ] **Step 1: Write failing tests for invalidation**

Add a new `describe` block to `tests/unit/github-cache.test.ts`:

```typescript
describe('GitHubService — cache invalidations on writes', () => {
  let github: GitHubService;
  let mockCache: ReturnType<typeof makeNullCache>;
  let mockOctokit: any;

  beforeEach(() => {
    mockCache = makeNullCache();
    github = new GitHubService({ token: 'test-token', cacheService: mockCache });
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

  it('invalidates issues cache after updateIssueLabel', async () => {
    await github.updateIssueLabel('owner', 'repo', 1, ['status:in-progress'], ['status:backlog']);

    expect(mockCache.invalidateIssues).toHaveBeenCalledWith('owner', 'repo');
  });

  it('invalidates issues cache after createIssue', async () => {
    // ensureLabelsExist calls graphql internally — mock it to return all labels
    const allLabelNames = [
      'priority:critical', 'priority:high', 'priority:medium', 'priority:low',
      'type:bug', 'type:feature', 'type:chore', 'type:docs',
      'status:backlog', 'status:in-progress', 'status:in-review', 'status:blocked',
    ];
    (mockCache.getLabels as ReturnType<typeof vi.fn>).mockResolvedValue(allLabelNames);

    await github.createIssue({
      owner: 'owner', repo: 'repo', title: 'New issue', priority: 'high', type: 'bug',
    });

    expect(mockCache.invalidateIssues).toHaveBeenCalledWith('owner', 'repo');
  });

  it('invalidates issues cache after closeIssue', async () => {
    await github.closeIssue('owner', 'repo', 1);

    expect(mockCache.invalidateIssues).toHaveBeenCalledWith('owner', 'repo');
  });

  it('invalidates issues cache after updateIssueState', async () => {
    await github.updateIssueState('owner', 'repo', 1, 'closed');

    expect(mockCache.invalidateIssues).toHaveBeenCalledWith('owner', 'repo');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/unit/github-cache.test.ts 2>&1 | tail -20
```

Expected: invalidation tests FAIL — no `invalidateIssues` calls yet.

- [ ] **Step 3: Add invalidation calls to write methods in `src/services/github.ts`**

**`updateIssueLabel`** — add at the end, after the `addLabels` block:

```typescript
  async updateIssueLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    addLabels: string[],
    removeLabels: string[]
  ): Promise<void> {
    for (const label of removeLabels) {
      try {
        await this.octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
    }
    if (addLabels.length > 0) {
      await this.octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: addLabels });
    }
    await this.cacheService.invalidateIssues(owner, repo);
  }
```

**`createIssue`** — add `await this.cacheService.invalidateIssues(owner, repo);` after the `octokit.issues.create` call, before the return:

```typescript
    const response = await this.octokit.issues.create({ owner, repo, title, body: body ?? '', labels });
    await this.cacheService.invalidateIssues(owner, repo);
    return this.mapApiIssue(response.data, owner, repo);
```

**`closeIssue`** — add invalidation after the update call:

```typescript
  async closeIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
    await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
    await this.cacheService.invalidateIssues(owner, repo);
  }
```

**`updateIssueState`** — add invalidation after the update call:

```typescript
  async updateIssueState(owner: string, repo: string, issueNumber: number, state: 'open' | 'closed'): Promise<void> {
    await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, state });
    await this.cacheService.invalidateIssues(owner, repo);
  }
```

- [ ] **Step 4: Run invalidation tests to verify they pass**

```bash
npx vitest run tests/unit/github-cache.test.ts 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 5: Run full suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/github.ts tests/unit/github-cache.test.ts
git commit -m "feat(cache): invalidate issues cache after label/state write operations"
```

---

## Task 5: Export and initialize `CacheService`

**Files:**
- Modify: `src/services/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Export from `src/services/index.ts`**

Add the cache export:

```typescript
export * from './batch.js';
export * from './cache.js';
export * from './github.js';
export * from './locking.js';
export * from './logging.js';
export * from './priority.js';
export * from './workflow.js';
```

- [ ] **Step 2: Initialize `CacheService` at startup in `src/index.ts`**

Add the import:

```typescript
import { initializeCacheService } from './services/cache.js';
```

In `main()`, add `initializeCacheService()` after `initializeGitHubService`:

```typescript
    initializeLogger(config.sessionId);
    initializeCacheService(config.cacheDir);
    initializeGitHubService(config.githubToken);
```

- [ ] **Step 3: Run full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 4: Run lint**

```bash
npm run lint 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/index.ts src/index.ts
git commit -m "feat(cache): initialize CacheService at startup, export from services"
```

---

## Self-Review Notes

**Spec coverage check:**

| Spec requirement | Covered by |
|---|---|
| Atomic writes (tmp → rename) | Task 2, `atomicWrite` function |
| Delta fetch via `filterBy: { since }` | Task 3, `fetchDeltaNodes` + `LIST_ISSUES_DELTA_QUERY` |
| Full refresh on miss / 24h stale / parse error | Task 3, `listOpenIssuesWithParents` |
| OPEN → upsert, CLOSED → evict merge | Task 3, `mergeIssueDelta` |
| Dependency map update in delta | Task 3, `mergeIssueDelta` |
| Empty repo → current timestamp as baseline | Task 3, `computeLastModifiedAt` |
| Invalidate after `updateIssueLabel` | Task 4 |
| Invalidate after `createIssue` | Task 4 |
| Invalidate after `closeIssue` / `updateIssueState` | Task 4 |
| Labels cache (1h TTL) | Task 2 (`LABELS_TTL_MS`), Task 3 (`ensureLabelsExist`) |
| PR cache (60s open, ∞ terminal) | Task 2 (`PR_OPEN_TTL_MS`, `null` TTL), Task 3 (`getPrStatus`) |
| `listOpenIssues` served from issues cache | Task 3, Step 8 |
| `getCacheDir` in config | Task 1 |
| Export + initialize in startup | Task 5 |
| Cache errors never surface to tool callers | Task 2 (`setIssues` catches and logs) |
| Existing tests updated to inject null cache | Task 3, Step 11 |
