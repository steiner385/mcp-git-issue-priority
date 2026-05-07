# Cache Layer Design — mcp-git-issue-priority

**Date:** 2026-05-06
**Status:** Approved

## Goal

Reduce GitHub API consumption for parallel, frequently-restarting MCP server sessions. Primary concern is rate limits; latency improvement is a secondary benefit. In-memory cache is insufficient because the server restarts between calls and multiple sessions run concurrently.

## Non-Goals

- Thundering herd prevention (multiple sessions fetching on a miss is acceptable — wasteful but not harmful)
- ETag/conditional-request support for REST paths (marginal gain; hot paths are already GraphQL)
- Background/async cache refresh

---

## Architecture

```
Tool → GitHubService → CacheService → disk
                     ↘              ↗
                       GitHub API
```

`CacheService` is a new singleton (`src/services/cache.ts`) following the same pattern as `LockingService` and `WorkflowService`. `GitHubService` calls through it on reads; mutating methods call `invalidate*` after writing. Tools do not change.

---

## Storage

### Location

```
~/.mcp-git-issue-priority/cache/<owner>__<repo>/issues.json
~/.mcp-git-issue-priority/cache/<owner>__<repo>/labels.json
~/.mcp-git-issue-priority/cache/<owner>__<repo>/pr-<N>.json
```

The `<owner>__<repo>` directory isolates repos. Double underscore avoids collision with repo names containing a single underscore.

### File Envelope

Every cache file is a JSON object with this shape:

```jsonc
{
  "v": 1,
  "fetchedAt": 1746500000000,      // Date.now() at write time
  "lastModifiedAt": "2026-05-06T12:00:00.000Z",  // issues only
  "ttl": 90000,                    // ms; null = never-expire (terminal PR states)
  "data": <T>
}
```

The `v` field enables format migrations without parse errors on old files.

`Map<number, number | null>` (issue dependencies) is not JSON-serializable. It is stored as `[number, number | null][]` (entries array) and reconstructed via `new Map(entries)` on read.

### Write Safety (Corruption Prevention)

Every write:

1. Serializes to a JSON string
2. Writes to `<finalPath>.<uuid>.tmp`
3. Calls `fs.rename(tmpPath, finalPath)` — atomic on POSIX and NTFS

Readers always see either the old complete file or the new complete file, never a partial write. Concurrent writers produce valid files; the last rename wins. Reads use try/catch JSON.parse — any error is treated as a cache miss (fail-open, never fail-closed).

---

## Cache Entries

### Issues (`issues.json`)

**Strategy:** Delta-aware. Tracks the most recent `updatedAt` timestamp seen across all cached issues. Subsequent fetches query only issues modified since then, then merge results into the existing cache.

**Data shape:**
```typescript
interface CachedIssues {
  issues: Issue[];
  dependencies: [number, number | null][];  // serialized Map entries
}
```

**Fetch flow:**

```
load cache file
  ├── missing / parse error / fetchedAt > 24h old
  │     → full GraphQL fetch (existing LIST_ISSUES_WITH_PARENTS_QUERY)
  │     → write cache with lastModifiedAt = max(issue.updatedAt)
  │
  └── cache hit with lastModifiedAt present
        → delta GraphQL fetch (new LIST_ISSUES_DELTA_QUERY, since: lastModifiedAt)
        → merge: OPEN → upsert, CLOSED → delete from map
        → update lastModifiedAt = max(all cached issues.updatedAt)
        → write updated cache atomically
```

**Full-refresh fallback triggers:**
- No cache file
- JSON parse error
- `fetchedAt` older than 24 hours
- Delta query throws (GraphQL error)

**Empty repo edge case:** If the full fetch returns zero issues, `lastModifiedAt` is set to the current UTC timestamp (`new Date().toISOString()`). This ensures the delta query on the next call uses a valid `since` value and returns nothing, which is correct.

**Post-write invalidation:** `updateIssueLabel`, `createIssue`, `closeIssue`, `updateIssueState` all call `cache.invalidateIssues(owner, repo)` after their write succeeds. This deletes the cache file. The next read triggers a fresh full fetch (no `lastModifiedAt` present), re-establishing the delta baseline.

### Labels (`labels.json`)

**Strategy:** TTL-only (1 hour). Labels are nearly immutable.

**Data shape:** `string[]` — label names only (sufficient for the "does this label exist?" check in `ensureLabelsExist`).

**Invalidation:** None beyond TTL. If a label `createLabel` call succeeds inside `ensureLabelsExist`, the labels cache is deleted so the next call re-fetches the complete set.

### PR Status (`pr-<N>.json`)

**Strategy:** TTL for open PRs (60 seconds); never-expire for terminal states.

**Data shape:** `PrStatus` (existing model).

**TTL logic:**
- `state === 'open'` → `ttl: 60_000`
- `state === 'merged' | 'closed'` → `ttl: null` (stored as JSON `null`, treated as Infinity on read)

Terminal states are immutable on GitHub; once cached they never need re-fetching.

---

## New GraphQL Query

Add `LIST_ISSUES_DELTA_QUERY` to `src/services/github-graphql.ts`:

```graphql
query ListUpdatedIssues($owner: String!, $repo: String!, $since: DateTime!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: 100, after: $cursor, filterBy: { since: $since }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body state url createdAt updatedAt
        labels(first: 20) { nodes { name color description } }
        assignees(first: 10) { nodes { login } }
        parent { number state }
      }
    }
  }
}
```

No `states: [OPEN]` filter — closed issues must appear in the delta so they can be evicted from the cache.

---

## CacheService API

```typescript
class CacheService {
  // Issues
  async getIssues(owner: string, repo: string): Promise<{ data: CachedIssues; lastModifiedAt: string } | null>
  async setIssues(owner: string, repo: string, data: CachedIssues, lastModifiedAt: string): Promise<void>
  async invalidateIssues(owner: string, repo: string): Promise<void>

  // Labels
  async getLabels(owner: string, repo: string): Promise<string[] | null>
  async setLabels(owner: string, repo: string, names: string[]): Promise<void>
  async invalidateLabels(owner: string, repo: string): Promise<void>

  // PR status
  async getPrStatus(owner: string, repo: string, prNumber: number): Promise<PrStatus | null>
  async setPrStatus(owner: string, repo: string, prNumber: number, status: PrStatus): Promise<void>
}

// Singleton accessors (same pattern as other services)
export function getCacheService(): CacheService
export function initializeCacheService(cacheDir?: string): CacheService
```

All `set*` and `invalidate*` methods use atomic write or `fs.unlink` with try/catch (missing file on invalidate is not an error).

---

## GitHubService Integration

| Method | Change |
|---|---|
| `listOpenIssuesWithParents` | Check issues cache → hit: return; miss: full fetch; `lastModifiedAt` present: delta + merge |
| `listOpenIssues` | Served from same issues cache — return `data.issues` only (drop dependencies) |
| `updateIssueLabel` | After write: `cache.invalidateIssues()` |
| `createIssue` | After write: `cache.invalidateIssues()` |
| `closeIssue` | After write: `cache.invalidateIssues()` |
| `updateIssueState` | After write: `cache.invalidateIssues()` |
| `ensureLabelsExist` | Check labels cache; on GraphQL success: `cache.setLabels()`; on label creation: `cache.invalidateLabels()` |
| `getPrStatus` | Check PR cache; on fetch: `cache.setPrStatus()` |

---

## Error Handling

- **Parse error on read:** treat as miss, log a warning, proceed with fetch
- **Write failure:** log a warning, proceed without caching (degrade gracefully — correctness is preserved, rate-limit benefit is lost for that call)
- **`invalidate` on missing file:** swallow `ENOENT`, no error
- **Delta query failure:** fall back to full fetch, log a warning

Cache errors must never surface to tool callers.

---

## Testing

- Unit tests for `CacheService`: hit, miss, TTL expiry, parse error recovery, atomic write verification, invalidation
- Unit tests for merge logic: upsert open issue, evict closed issue, dependency map reconstruction
- Integration tests for `GitHubService` cache integration: mock `CacheService`, verify cache is checked before API, verify invalidation is called after writes
- Existing tool-level tests must pass unchanged (cache is transparent to tools)

---

## File Inventory

| File | Action |
|---|---|
| `src/services/cache.ts` | New |
| `src/services/github-graphql.ts` | Add `LIST_ISSUES_DELTA_QUERY` + types |
| `src/services/github.ts` | Integrate `CacheService` into read/write methods |
| `src/services/index.ts` | Export `CacheService`, `getCacheService`, `initializeCacheService` |
| `src/index.ts` | Call `initializeCacheService()` at startup |
| `tests/cache.test.ts` | New |
| `tests/github.cache.test.ts` | New |
