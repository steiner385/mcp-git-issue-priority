# Quickstart: MCP GitHub Issue Priority Server

**Date**: 2026-01-31
**Branch**: 001-mcp-issue-priority

This guide demonstrates the core user journeys for the MCP GitHub Issue Priority server.

---

## Prerequisites

- GitHub Personal Access Token with `repo` scope
- Node.js 20 LTS or later
- Claude Code or another MCP-compatible AI assistant

---

## Installation

```bash
# Install the MCP server globally
npm install -g mcp-git-issue-priority

# Or add to your Claude Code MCP configuration
# ~/.claude.json
{
  "mcpServers": {
    "issue-priority": {
      "command": "npx",
      "args": ["mcp-git-issue-priority"],
      "env": {
        "GITHUB_TOKEN": "your-github-token"
      }
    }
  }
}
```

---

## User Journey 1: Create a Properly Tagged Issue

**Goal**: Create a new bug report with correct priority and type labels.

### Step 1: Create the issue

```
User: Create a new bug issue titled "Login button unresponsive on Safari"
      with high priority. The context is that users on Safari 17+ can't
      click the login button. Acceptance criteria: button responds within
      500ms on Safari 17+.
```

### Expected MCP Tool Call

```json
{
  "tool": "create_issue",
  "arguments": {
    "title": "Login button unresponsive on Safari",
    "type": "bug",
    "priority": "high",
    "context": "Users on Safari 17+ can't click the login button",
    "acceptanceCriteria": ["Button responds within 500ms on Safari 17+"]
  }
}
```

### Expected Result

```json
{
  "success": true,
  "issue": {
    "number": 42,
    "title": "Login button unresponsive on Safari",
    "html_url": "https://github.com/owner/repo/issues/42",
    "labels": ["type:bug", "priority:high", "status:backlog"]
  }
}
```

### Verification

1. Issue appears in GitHub with correct labels
2. Issue body follows standard template
3. Labels are created in repo if they didn't exist

---

## User Journey 2: Select and Work on Next Priority Issue

**Goal**: Automatically select the highest-priority issue and begin work.

### Step 1: Select next issue

```
User: What's the next issue I should work on?
```

### Expected MCP Tool Call

```json
{
  "tool": "select_next_issue",
  "arguments": {}
}
```

### Expected Result

```json
{
  "success": true,
  "issue": {
    "number": 42,
    "title": "Login button unresponsive on Safari",
    "priority": "high",
    "type": "bug",
    "priorityScore": 105,
    "ageInDays": 5
  },
  "lock": {
    "sessionId": "a1b2c3d4-...",
    "acquiredAt": "2026-01-31T10:00:00Z"
  },
  "workflow": {
    "currentPhase": "selection"
  }
}
```

### Step 2: Research phase

```
User: I've reviewed the issue. Let's create a branch.
```

### Expected MCP Tool Call

```json
{
  "tool": "advance_workflow",
  "arguments": {
    "issueNumber": 42,
    "targetPhase": "branch"
  }
}
```

### Expected Result

```json
{
  "success": true,
  "workflow": {
    "previousPhase": "selection",
    "currentPhase": "branch",
    "branchName": "42-login-button-unresponsive-on-safari"
  }
}
```

### Step 3: Implementation and Testing

```
User: I've implemented the fix. Tests pass. Let's create a PR.
```

### Expected MCP Tool Call

```json
{
  "tool": "advance_workflow",
  "arguments": {
    "issueNumber": 42,
    "targetPhase": "pr",
    "testsPassed": true,
    "prTitle": "fix: resolve Safari login button responsiveness (#42)",
    "prBody": "## Summary\nFixes login button unresponsive on Safari 17+\n\n## Test Evidence\nManual testing on Safari 17.2 - button responds in <100ms\n\nCloses #42"
  }
}
```

### Expected Result

```json
{
  "success": true,
  "workflow": {
    "previousPhase": "testing",
    "currentPhase": "pr",
    "branchName": "42-login-button-unresponsive-on-safari",
    "prNumber": 43,
    "prUrl": "https://github.com/owner/repo/pull/43"
  }
}
```

---

## User Journey 3: Concurrent Session Safety

**Goal**: Demonstrate that two sessions don't select the same issue.

### Scenario Setup

- Session A and Session B both call `select_next_issue` simultaneously
- Backlog has issues #42 (score: 105) and #41 (score: 100)

### Session A (first to acquire lock)

```json
{
  "success": true,
  "issue": { "number": 42, "priorityScore": 105 }
}
```

### Session B (lock on #42 failed, gets next)

```json
{
  "success": true,
  "issue": { "number": 41, "priorityScore": 100 }
}
```

### Verification

- Both sessions get different issues
- Both issues have `status:in-progress` label in GitHub
- Lock files exist for both: `owner_repo_42.lock` and `owner_repo_41.lock`

---

## User Journey 4: Filter by Issue Type

**Goal**: Select only bug issues (ignoring features and chores).

### Step 1: Select with type filter

```
User: I want to focus on bugs today. What's the next bug I should fix?
```

### Expected MCP Tool Call

```json
{
  "tool": "select_next_issue",
  "arguments": {
    "includeTypes": ["bug"]
  }
}
```

### Expected Result

Only issues with `type:bug` label are considered for selection.

---

## User Journey 5: Force Claim a Stale Lock

**Goal**: Take over an issue that was abandoned by another session.

### Scenario

- Issue #42 is locked by Session A (which crashed)
- Session B wants to continue the work

### Step 1: Attempt normal selection

```
User: I want to work on issue #42
```

Session B receives error: "Issue #42 is locked by another session"

### Step 2: Force claim

```
User: The other session crashed. I need to take over issue #42.
```

### Expected MCP Tool Call

```json
{
  "tool": "force_claim",
  "arguments": {
    "issueNumber": 42,
    "confirmation": "I understand this may cause conflicts"
  }
}
```

### Expected Result

```json
{
  "success": true,
  "claimed": {
    "issueNumber": 42,
    "previousHolder": {
      "sessionId": "old-session-id",
      "acquiredAt": "2026-01-31T08:00:00Z",
      "pid": 12345
    }
  },
  "lock": {
    "sessionId": "new-session-id",
    "acquiredAt": "2026-01-31T10:30:00Z"
  }
}
```

### Verification

- Lock file updated with new session
- GitHub issue has comment noting takeover
- Audit log records force claim with previous holder

---

## User Journey 6: Abandon Work

**Goal**: Release a lock when work cannot be completed.

### Step 1: Abandon the issue

```
User: I can't finish this issue right now. Release it back to the backlog.
```

### Expected MCP Tool Call

```json
{
  "tool": "release_lock",
  "arguments": {
    "issueNumber": 42,
    "reason": "abandoned"
  }
}
```

### Expected Result

```json
{
  "success": true,
  "released": {
    "issueNumber": 42,
    "reason": "abandoned",
    "duration": 3600
  }
}
```

### Verification

- Lock file deleted
- WorkflowState file deleted
- Issue label changed: `status:in-progress` → `status:backlog`
- Issue remains open for others to claim

---

## User Journey 7: View Backlog

**Goal**: See prioritized list of available issues.

### Step 1: List backlog

```
User: Show me the current backlog
```

### Expected MCP Tool Call

```json
{
  "tool": "list_backlog",
  "arguments": {
    "limit": 10
  }
}
```

### Expected Result

```json
{
  "success": true,
  "backlog": [
    {
      "number": 42,
      "title": "Login button unresponsive on Safari",
      "priority": "high",
      "type": "bug",
      "priorityScore": 105,
      "ageInDays": 5,
      "isLocked": false
    },
    {
      "number": 41,
      "title": "Add dark mode support",
      "priority": "medium",
      "type": "feature",
      "priorityScore": 17,
      "ageInDays": 7,
      "isLocked": true,
      "lockedBy": "session-xyz"
    }
  ],
  "total": 25
}
```

---

## Error Scenarios

### Scenario: No issues in backlog

```json
{
  "success": false,
  "error": "No issues match criteria",
  "code": "NO_ISSUES_AVAILABLE",
  "reason": "no_issues"
}
```

### Scenario: Tests required but not run

```json
{
  "success": false,
  "error": "Tests must pass before creating PR",
  "code": "TESTS_REQUIRED",
  "reason": "tests_required"
}
```

**Resolution**: Either run tests and set `testsPassed: true`, or provide `skipJustification` with reason.

### Scenario: Invalid confirmation for force claim

```json
{
  "success": false,
  "error": "Confirmation string does not match",
  "code": "INVALID_CONFIRMATION"
}
```

**Resolution**: Must provide exact string: `"I understand this may cause conflicts"`

---

## Audit Log Sample

After the above journeys, the audit log would contain:

```jsonl
{"timestamp":"2026-01-31T10:00:00Z","level":"info","tool":"create_issue","sessionId":"abc123","issueNumber":42,"outcome":"success"}
{"timestamp":"2026-01-31T10:01:00Z","level":"info","tool":"select_next_issue","sessionId":"abc123","issueNumber":42,"phase":"selection","outcome":"success"}
{"timestamp":"2026-01-31T10:02:00Z","level":"info","tool":"advance_workflow","sessionId":"abc123","issueNumber":42,"phase":"branch","outcome":"success"}
{"timestamp":"2026-01-31T10:30:00Z","level":"warn","tool":"force_claim","sessionId":"def456","issueNumber":42,"outcome":"success","metadata":{"previousSession":"abc123"}}
```
