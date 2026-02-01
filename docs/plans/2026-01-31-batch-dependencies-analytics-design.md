# Batch Implementation, Dependencies, and Analytics Design

**Date:** 2026-01-31
**Status:** Approved

## Overview

This design adds five major capabilities to the MCP GitHub Issue Priority Server:

1. **Batch Implementation** - Implement N issues in sequence, waiting for CI/merge
2. **Dependencies** - Soft-block issues based on GitHub sub-issues
3. **PR Integration** - Check PR status (CI, reviews, merge state)
4. **Batch Operations** - Bulk label and state changes
5. **Analytics** - Time-based workflow metrics

## New Tools

| Tool | Purpose |
|------|---------|
| `implement_batch` | Start a batch of N issues, returns first issue to implement |
| `batch_continue` | Poll for PR merge, return next issue or completion |
| `get_pr_status` | Check CI status, approval state, merge state of a PR |
| `bulk_update_issues` | Add/remove labels, close/reopen multiple issues |
| `get_workflow_analytics` | Time-in-phase, cycle time, aging reports |

## Feature 1: Batch Implementation

### `implement_batch` Tool

```typescript
Arguments:
  - repository: string       // "owner/repo"
  - count: number           // How many issues to implement (1-10)
  - includeTypes?: string[] // Filter by type (default: all)
  - maxPriority?: string    // Only P0, P1, etc. (default: all)
```

Returns:
```typescript
// When there's an issue to implement:
{
  action: "implement",
  batchId: string,
  progress: { current: 1, total: 5 },
  issue: Issue,
  instructions: string  // "Implement issue #42: <title>. Create PR when ready."
}

// When no eligible issues:
{
  action: "empty",
  reason: "No issues match criteria"
}
```

### `batch_continue` Tool

```typescript
Arguments:
  - batchId: string
  - prNumber?: number  // PR created for the current issue
```

Behavior:
1. If `prNumber` provided, store it and start polling
2. Poll GitHub every 60 seconds for up to 30 minutes:
   - Check CI status (all checks passing?)
   - Check merge status (merged?)
3. On merge: select next issue, return `{action: "implement", ...}`
4. On timeout: return `{action: "timeout", issue: #, prNumber: #}`
5. On batch complete: return `{action: "complete", summary: {...}}`

### Batch State Persistence

Stored in `~/.mcp-git-issue-priority/batches/`:
```typescript
interface BatchState {
  batchId: string;
  repository: string;
  totalCount: number;
  completedCount: number;
  currentIssue: number | null;
  currentPr: number | null;
  queue: number[];  // Remaining issue numbers
  completed: Array<{
    issue: number;
    pr: number;
    startedAt: string;
    mergedAt: string;
  }>;
  startedAt: string;
  status: "in_progress" | "completed" | "timeout" | "abandoned";
}
```

## Feature 2: Dependencies via Sub-Issues

### GitHub Sub-Issues API

```typescript
// Fetch sub-issues for an issue
GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues

// Response includes:
{
  sub_issues: [{ number: 45, state: "open", ... }],
  parent: { number: 42, state: "open", ... } | null
}
```

### Priority Scoring Change

```typescript
// Current formula:
score = (basePoints + ageBonus) * blockingMultiplier

// New formula:
score = (basePoints + ageBonus) * blockingMultiplier * blockedPenalty

// Where:
blockedPenalty = hasOpenParent ? 0.1 : 1.0
```

A P1 issue (100 points) that's blocked becomes effectively P3-level (10 points).

### Display in `list_backlog`

```
#42  P1 bug   "Fix auth flow"           Score: 105
#45  P2 feat  "Add OAuth" [blocked:#42] Score: 12  ← penalty applied
#48  P0 bug   "Critical crash"          Score: 1003
```

## Feature 3: PR Status Checking

### `get_pr_status` Tool

```typescript
Arguments:
  - repository: string   // "owner/repo"
  - prNumber: number     // PR number to check
```

Returns:
```typescript
{
  prNumber: number,
  state: "open" | "closed" | "merged",
  mergeable: boolean | null,  // null if still calculating

  ci: {
    status: "pending" | "passing" | "failing" | "none",
    checks: [
      { name: "build", status: "success" },
      { name: "test", status: "pending" },
    ]
  },

  reviews: {
    approved: boolean,
    changesRequested: boolean,
    reviewers: ["alice", "bob"]
  },

  autoMerge: {
    enabled: boolean
  }
}
```

### GitHub API Endpoints Used

| Data | Endpoint |
|------|----------|
| PR state, mergeable | `GET /repos/{owner}/{repo}/pulls/{pr}` |
| CI checks | `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` |
| Reviews | `GET /repos/{owner}/{repo}/pulls/{pr}/reviews` |

### Merge Readiness Check

Used by `batch_continue` to determine when to proceed:
```typescript
const ready = status.state === "merged" ||
              (status.ci.status === "passing" &&
               status.reviews.approved &&
               status.autoMerge.enabled);
```

## Feature 4: Batch Operations

### `bulk_update_issues` Tool

```typescript
Arguments:
  - repository: string
  - issues: number[]           // Issue numbers to update
  - addLabels?: string[]       // Labels to add
  - removeLabels?: string[]    // Labels to remove
  - state?: "open" | "closed"  // Change state
```

Returns:
```typescript
{
  updated: number[],    // Successfully updated
  failed: [
    { issue: 42, error: "Issue not found" }
  ],
  summary: {
    total: 5,
    succeeded: 4,
    failed: 1
  }
}
```

### Rate Limiting

- Processes issues sequentially to respect GitHub API limits
- Uses existing Octokit retry/throttle plugins
- Returns partial success if some operations fail

## Feature 5: Time-Based Analytics

### `get_workflow_analytics` Tool

```typescript
Arguments:
  - repository: string
  - period?: "7d" | "30d" | "90d" | "all"  // Default: 30d
```

Returns:
```typescript
{
  period: { start: "2026-01-01", end: "2026-01-31" },

  cycleTime: {
    average: "3d 4h",      // Selection to merged
    median: "2d 12h",
    p90: "7d 2h"
  },

  phaseBreakdown: {
    research:       { average: "2h",  median: "1h" },
    branch:         { average: "10m", median: "5m" },
    implementation: { average: "1d",  median: "18h" },
    testing:        { average: "3h",  median: "2h" },
    commit:         { average: "15m", median: "10m" },
    pr:             { average: "30m", median: "20m" },
    review:         { average: "1d",  median: "12h" }
  },

  issuesCompleted: 12,
  issuesAbandoned: 2,

  aging: {
    oldest: { issue: 42, age: "45d", priority: "P2" },
    stale: [  // No activity in 14+ days
      { issue: 38, age: "21d", lastPhase: "implementation" }
    ]
  }
}
```

### Data Source

- Reads from workflow state files in `~/.mcp-git-issue-priority/workflow/`
- Phase timestamps already captured in `phaseHistory`
- No additional tracking needed

## Implementation Plan

### Files to Create

| File | Purpose |
|------|---------|
| `src/models/batch-state.ts` | Batch tracking schema |
| `src/models/pr-status.ts` | PR status schema |
| `src/tools/implement-batch.ts` | Start batch tool |
| `src/tools/batch-continue.ts` | Continue batch tool |
| `src/tools/get-pr-status.ts` | PR status tool |
| `src/tools/bulk-update-issues.ts` | Bulk operations tool |
| `src/tools/get-workflow-analytics.ts` | Analytics tool |

### Files to Modify

| File | Change |
|------|--------|
| `src/services/github.ts` | Add sub-issues, PR status, check-runs API calls |
| `src/services/priority.ts` | Add blocked penalty to scoring |
| `src/tools/list-backlog.ts` | Show blocked status |
| `src/tools/select-next-issue.ts` | Apply blocked penalty |
| `src/index.ts` | Register new tools |

### Testing Strategy

- Unit tests for each new tool
- Unit tests for priority scoring with blocked penalty
- Integration tests for batch flow (mocked GitHub API)
- Integration tests for sub-issues dependency detection
