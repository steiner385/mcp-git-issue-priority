# MCP Tool Contracts

**Date**: 2026-01-31
**Branch**: 001-mcp-issue-priority

This document defines the MCP tool schemas for the GitHub Issue Priority server.

---

## Tool: `create_issue`

Create a new GitHub issue with mandatory priority and type labels.

### Input Schema

```typescript
{
  // Required
  title: z.string().min(1).max(256).describe("Issue title"),
  priority: z.enum(["critical", "high", "medium", "low"]).describe("Priority level"),
  type: z.enum(["bug", "feature", "chore", "docs"]).describe("Issue type"),

  // Optional
  body: z.string().optional().describe("Issue body in markdown"),
  context: z.string().optional().describe("Context/background for the issue"),
  acceptanceCriteria: z.array(z.string()).optional().describe("List of acceptance criteria"),
  technicalNotes: z.string().optional().describe("Implementation hints"),
  repository: z.string().optional().describe("Repository in 'owner/repo' format. Uses current repo if not specified."),
}
```

### Output

```typescript
{
  success: true,
  issue: {
    number: number,
    title: string,
    html_url: string,
    labels: string[],
  }
}
// OR
{
  success: false,
  error: string,
}
```

### Behavior

1. Validate repository access (write permissions)
2. Ensure all required labels exist in repository (create if missing)
3. Format body using standard template:
   ```markdown
   ## Summary
   {title}

   ## Context
   {context}

   ## Acceptance Criteria
   - [ ] {criterion1}
   - [ ] {criterion2}

   ## Technical Notes
   {technicalNotes}
   ```
4. Create issue with labels: `priority:{priority}`, `type:{type}`, `status:backlog`
5. Log action to audit log

### Errors

| Code | Message | Cause |
|------|---------|-------|
| `REPO_NOT_FOUND` | Repository not found | Invalid owner/repo |
| `NO_WRITE_ACCESS` | No write access to repository | Missing permissions |
| `GITHUB_API_ERROR` | GitHub API error: {details} | API failure |

---

## Tool: `select_next_issue`

Select and lock the highest-priority issue from the backlog.

### Input Schema

```typescript
{
  // Optional filters
  includeTypes: z.array(z.enum(["bug", "feature", "chore", "docs"])).optional()
    .describe("Only select from these types"),
  excludeTypes: z.array(z.enum(["bug", "feature", "chore", "docs"])).optional()
    .describe("Exclude these types from selection"),
  repository: z.string().optional()
    .describe("Repository in 'owner/repo' format. Uses current repo if not specified."),
}
```

### Output

```typescript
{
  success: true,
  issue: {
    number: number,
    title: string,
    html_url: string,
    priority: string,
    type: string,
    priorityScore: number,
    ageInDays: number,
  },
  lock: {
    sessionId: string,
    acquiredAt: string,
  },
  workflow: {
    currentPhase: "selection",
  }
}
// OR
{
  success: false,
  error: string,
  reason: "no_issues" | "all_locked" | "lock_failed" | "api_error",
}
```

### Behavior

1. Fetch all open issues from repository
2. Filter: exclude PRs, exclude `status:in-progress` labeled issues
3. Apply `includeTypes` filter (if specified)
4. Apply `excludeTypes` filter (if specified)
5. Calculate priority scores for remaining issues
6. Sort by score DESC, then issue number ASC
7. For each candidate (highest first):
   a. Attempt to acquire local file lock
   b. If lock acquired:
      - Apply `status:in-progress` label to GitHub issue
      - Create WorkflowState file
      - Log action
      - Return selected issue
   c. If lock failed, try next candidate
8. If no issues available or all locked, return failure

### Lock Acquisition Sequence

```
1. Check lock file exists
   ├── No  → Create lock file → Success
   └── Yes → Read lock file
             ├── PID not alive → Delete stale lock → Create new → Success
             └── PID alive → Lock failure (try next issue)
```

### Errors

| Code | Message | Cause |
|------|---------|-------|
| `NO_ISSUES_AVAILABLE` | No issues match criteria | Empty backlog or all filtered |
| `ALL_ISSUES_LOCKED` | All matching issues are locked | Concurrent sessions |
| `LOCK_ACQUISITION_FAILED` | Failed to acquire lock | File system error |
| `GITHUB_API_ERROR` | GitHub API error: {details} | API failure |

---

## Tool: `advance_workflow`

Advance the workflow to the next phase for the currently locked issue.

### Input Schema

```typescript
{
  issueNumber: z.number().int().positive().describe("Issue number to advance"),
  targetPhase: z.enum([
    "research", "branch", "implementation", "testing", "commit", "pr", "review"
  ]).describe("Target workflow phase"),
  skipJustification: z.string().optional()
    .describe("Required if skipping phases"),
  testsPassed: z.boolean().optional()
    .describe("Required when advancing to or past 'commit' phase"),
  prTitle: z.string().optional()
    .describe("PR title (required for 'pr' phase)"),
  prBody: z.string().optional()
    .describe("PR body (required for 'pr' phase)"),
  repository: z.string().optional(),
}
```

### Output

```typescript
{
  success: true,
  workflow: {
    previousPhase: string,
    currentPhase: string,
    branchName?: string,    // Set if phase is 'branch' or later
    prNumber?: number,      // Set if phase is 'pr' or later
    prUrl?: string,
  }
}
// OR
{
  success: false,
  error: string,
  reason: "not_locked" | "invalid_transition" | "tests_required" | "api_error",
}
```

### Behavior

**Phase: research → branch**
1. Create branch: `{issueNumber}-{kebab-case-title}`
2. Update WorkflowState with branchName

**Phase: implementation → testing**
1. Verify tests are available (check for test infrastructure)
2. Mark ready for testing (no automatic test run)

**Phase: testing → commit**
1. REQUIRE `testsPassed: true` OR `skipJustification`
2. If skipping, log justification

**Phase: commit → pr**
1. Create PR with:
   - Title: `{type}: {title} (#{issueNumber})`
   - Body: includes Summary, Test Evidence, Issue Reference
2. Update issue label: `status:in-progress` → `status:in-review`
3. Update WorkflowState with prNumber

**All Transitions**:
- Validate caller holds the lock
- Log phase transition to audit log
- Update WorkflowState

### Phase Validation Matrix

| From | To | Requirements |
|------|-----|--------------|
| selection | research | None |
| research | branch | None |
| branch | implementation | None |
| implementation | testing | None |
| testing | commit | `testsPassed=true` OR `skipJustification` |
| commit | pr | None |
| pr | review | None |
| Any | abandoned | None |

### Errors

| Code | Message | Cause |
|------|---------|-------|
| `NOT_LOCKED` | Issue not locked by this session | No lock or different session |
| `INVALID_PHASE_TRANSITION` | Cannot advance from {from} to {to} | Invalid workflow order |
| `TESTS_REQUIRED` | Tests must pass before PR | testsPassed not true and no skip |
| `BRANCH_EXISTS` | Branch already exists | Duplicate branch name |
| `PR_CREATION_FAILED` | Failed to create PR | GitHub API error |

---

## Tool: `release_lock`

Release lock on an issue (abandon or complete).

### Input Schema

```typescript
{
  issueNumber: z.number().int().positive().describe("Issue number"),
  reason: z.enum(["completed", "abandoned", "merged"]).describe("Release reason"),
  repository: z.string().optional(),
}
```

### Output

```typescript
{
  success: true,
  released: {
    issueNumber: number,
    reason: string,
    duration: number,  // Lock duration in seconds
  }
}
// OR
{
  success: false,
  error: string,
}
```

### Behavior

**Reason: completed / merged**
1. Delete lock file
2. Delete WorkflowState file
3. Update issue label to remove `status:in-progress`
4. Close issue if `merged`

**Reason: abandoned**
1. Delete lock file
2. Delete WorkflowState file
3. Update issue label: `status:in-progress` → `status:backlog`
4. Issue remains open for others to claim

**All**:
- Log release to audit log with duration

### Errors

| Code | Message | Cause |
|------|---------|-------|
| `NOT_LOCKED` | Issue not locked by this session | No lock or different session |
| `GITHUB_API_ERROR` | GitHub API error: {details} | Label update failed |

---

## Tool: `force_claim`

Force claim an issue that is locked by another session.

### Input Schema

```typescript
{
  issueNumber: z.number().int().positive().describe("Issue number to claim"),
  confirmation: z.literal("I understand this may cause conflicts")
    .describe("Required confirmation string"),
  repository: z.string().optional(),
}
```

### Output

```typescript
{
  success: true,
  claimed: {
    issueNumber: number,
    previousHolder: {
      sessionId: string,
      acquiredAt: string,
      pid: number,
    } | null,
  },
  lock: {
    sessionId: string,
    acquiredAt: string,
  }
}
// OR
{
  success: false,
  error: string,
}
```

### Behavior

1. Validate confirmation string matches exactly
2. Read existing lock file (if any)
3. Force delete existing lock
4. Create new lock with current session
5. Update WorkflowState (preserve phase history, reset current session)
6. Add comment to GitHub issue: "Issue claimed by new session (force claim)"
7. Log force claim with previous holder details

### Errors

| Code | Message | Cause |
|------|---------|-------|
| `INVALID_CONFIRMATION` | Confirmation string does not match | Missing or wrong confirmation |
| `ISSUE_NOT_FOUND` | Issue not found | Invalid issue number |
| `LOCK_WRITE_FAILED` | Failed to write lock file | File system error |

---

## Tool: `get_workflow_status`

Get the current workflow status for a locked issue.

### Input Schema

```typescript
{
  issueNumber: z.number().int().positive().optional()
    .describe("Specific issue number. If not provided, returns status for all locked issues."),
  repository: z.string().optional(),
}
```

### Output

```typescript
{
  success: true,
  workflows: [{
    issueNumber: number,
    title: string,
    currentPhase: string,
    branchName: string | null,
    testsPassed: boolean | null,
    prNumber: number | null,
    lockAcquiredAt: string,
    lockDuration: number,  // seconds
    phaseHistory: [{
      from: string,
      to: string,
      timestamp: string,
    }],
  }]
}
```

### Behavior

1. If `issueNumber` provided:
   - Read specific WorkflowState file
   - Verify lock exists and is held by current session
2. If not provided:
   - Scan all lock files for current session
   - Return status for all locked issues

---

## Tool: `list_backlog`

List issues in the backlog with priority scores (read-only, no locking).

### Input Schema

```typescript
{
  includeTypes: z.array(z.enum(["bug", "feature", "chore", "docs"])).optional(),
  excludeTypes: z.array(z.enum(["bug", "feature", "chore", "docs"])).optional(),
  limit: z.number().int().min(1).max(100).default(20)
    .describe("Maximum issues to return"),
  repository: z.string().optional(),
}
```

### Output

```typescript
{
  success: true,
  backlog: [{
    number: number,
    title: string,
    priority: string,
    type: string,
    priorityScore: number,
    ageInDays: number,
    isLocked: boolean,
    lockedBy: string | null,  // Session ID if locked
  }],
  total: number,
}
```

### Behavior

1. Fetch open issues
2. Apply filters
3. Calculate priority scores
4. Sort by score
5. Return top N with lock status

---

## Error Response Format

All tools return errors in a consistent format:

```typescript
{
  success: false,
  error: string,           // Human-readable message
  code?: string,           // Machine-readable error code
  reason?: string,         // Additional context
  details?: object,        // Extra error details
}
```

Example:
```json
{
  "success": false,
  "error": "All matching issues are currently locked",
  "code": "ALL_ISSUES_LOCKED",
  "reason": "all_locked",
  "details": {
    "totalIssues": 15,
    "matchingFilter": 8,
    "locked": 8
  }
}
```
