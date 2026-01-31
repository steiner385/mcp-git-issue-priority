# Data Model: MCP GitHub Issue Priority Server

**Date**: 2026-01-31
**Branch**: 001-mcp-issue-priority

## Entity Relationship Diagram

```
┌─────────────────┐         ┌─────────────────┐
│     Issue       │         │      Lock       │
│ (GitHub API)    │◄────────│  (Local File)   │
├─────────────────┤    1:1  ├─────────────────┤
│ number: int     │         │ issueNumber: int│
│ title: string   │         │ repoFullName    │
│ state: enum     │         │ pid: int        │
│ labels: Label[] │         │ sessionId: uuid │
│ created_at: ts  │         │ acquiredAt: ts  │
│ body: string    │         └────────┬────────┘
└────────┬────────┘                  │
         │                           │
         │ 1:N                       │ 1:1
         ▼                           ▼
┌─────────────────┐         ┌─────────────────┐
│     Label       │         │ WorkflowState   │
│ (GitHub API)    │         │  (Local File)   │
├─────────────────┤         ├─────────────────┤
│ name: string    │         │ issueNumber: int│
│ color: string   │         │ phase: enum     │
│ description     │         │ phaseHistory[]  │
└─────────────────┘         │ skipJustify[]   │
                            └─────────────────┘
         │
         │ calculated
         ▼
┌─────────────────┐
│ PriorityScore   │
│  (Computed)     │
├─────────────────┤
│ basePoints: int │
│ ageBonus: int   │
│ blockingMult    │
│ totalScore: int │
└─────────────────┘
```

---

## Entities

### Issue (GitHub API - Read/Write)

Represents a GitHub issue. Retrieved via Octokit, enriched with computed priority score.

```typescript
interface Issue {
  // From GitHub API
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  created_at: string;  // ISO 8601
  updated_at: string;  // ISO 8601
  labels: Label[];
  assignees: Assignee[];
  html_url: string;

  // Repository context (derived from API call)
  repository: {
    owner: string;
    repo: string;
    full_name: string;  // "owner/repo"
  };
}

interface Label {
  name: string;
  color: string;
  description: string | null;
}

interface Assignee {
  login: string;
}
```

**Validation Rules**:
- `number` must be positive integer
- `state` must be 'open' for selection candidates
- Must have exactly one `priority:*` label
- Must have exactly one `type:*` label

**State Transitions** (via label changes):
```
status:backlog → status:in-progress → status:in-review → [closed]
                        ↓
                 status:blocked
                        ↓
                 status:backlog (on abandon)
```

---

### Lock (Local File)

Represents exclusive claim on an issue. Stored as JSON file in `~/.mcp-git-issue-priority/locks/`.

```typescript
interface Lock {
  issueNumber: number;
  repoFullName: string;      // "owner/repo" - scopes lock to specific repo
  pid: number;               // Process ID of lock holder
  sessionId: string;         // UUID identifying the MCP session
  acquiredAt: string;        // ISO 8601 timestamp
  lastUpdated: string;       // ISO 8601 - updated by proper-lockfile
}
```

**File Location**: `~/.mcp-git-issue-priority/locks/{owner}_{repo}_{issue_number}.lock`

**Validation Rules**:
- `pid` must be positive integer
- `sessionId` must be valid UUID v4
- `acquiredAt` must be valid ISO 8601 timestamp
- Lock is stale if `pid` process is not alive AND timeout exceeded (30 min)

**Lifecycle**:
1. Created on successful issue selection
2. Updated periodically by proper-lockfile (mtime)
3. Deleted on: PR merge, issue close, explicit abandon, force claim

---

### WorkflowState (Local File)

Tracks the current workflow phase for a locked issue. Stored alongside lock file.

```typescript
interface WorkflowState {
  issueNumber: number;
  repoFullName: string;
  currentPhase: WorkflowPhase;
  phaseHistory: PhaseTransition[];
  skipJustifications: SkipJustification[];
  branchName: string | null;   // Set after branch phase
  testsPassed: boolean | null; // Set after test phase
  prNumber: number | null;     // Set after PR phase
}

type WorkflowPhase =
  | 'selection'
  | 'research'
  | 'branch'
  | 'implementation'
  | 'testing'
  | 'commit'
  | 'pr'
  | 'review'
  | 'merged'
  | 'abandoned';

interface PhaseTransition {
  from: WorkflowPhase;
  to: WorkflowPhase;
  timestamp: string;  // ISO 8601
  triggeredBy: string; // Tool name that triggered transition
}

interface SkipJustification {
  skippedPhase: WorkflowPhase;
  justification: string;
  timestamp: string;
  sessionId: string;
}
```

**File Location**: `~/.mcp-git-issue-priority/workflow/{owner}_{repo}_{issue_number}.json`

**Validation Rules**:
- `currentPhase` must be valid WorkflowPhase
- Phase transitions must follow allowed order (with skip logging)
- `testsPassed` must be true before `pr` phase (unless skip logged)

**Phase Transition Rules**:
```
selection → research → branch → implementation → testing → commit → pr → review → merged
                                      ↓
                                 abandoned (from any phase)
```

---

### PriorityScore (Computed)

Calculated value for deterministic issue ordering. Not persisted - computed on demand.

```typescript
interface PriorityScore {
  issueNumber: number;

  // Component scores
  basePoints: number;       // From priority label: critical=1000, high=100, medium=10, low=1
  ageBonus: number;         // Days since creation, max 30
  blockingMultiplier: number; // 1.0 or 1.5 if blocks other issues

  // Final score
  totalScore: number;       // (basePoints + ageBonus) * blockingMultiplier

  // Tiebreaker
  issueNumber: number;      // Lower number wins ties (FIFO)
}
```

**Calculation Formula**:
```typescript
function calculatePriority(issue: Issue): PriorityScore {
  const basePoints = {
    'priority:critical': 1000,
    'priority:high': 100,
    'priority:medium': 10,
    'priority:low': 1,
  }[getPriorityLabel(issue)];

  const daysSinceCreation = Math.floor(
    (Date.now() - new Date(issue.created_at).getTime()) / (1000 * 60 * 60 * 24)
  );
  const ageBonus = Math.min(daysSinceCreation, 30);

  const blocksOthers = hasBlockingRelationship(issue);
  const blockingMultiplier = blocksOthers ? 1.5 : 1.0;

  const totalScore = (basePoints + ageBonus) * blockingMultiplier;

  return { issueNumber: issue.number, basePoints, ageBonus, blockingMultiplier, totalScore };
}
```

**Sorting**: Issues sorted by `totalScore DESC`, then `issueNumber ASC` (oldest first for ties).

---

### SelectionFilter (Input Parameter)

User-provided criteria for narrowing issue candidate pool. Passed as tool input.

```typescript
interface SelectionFilter {
  includeTypes?: IssueType[];  // Only these types (whitelist)
  excludeTypes?: IssueType[];  // Skip these types (blacklist)
}

type IssueType = 'bug' | 'feature' | 'chore' | 'docs';
```

**Filter Application Order**:
1. Exclude issues with `status:in-progress` label
2. Apply `includeTypes` filter (if specified)
3. Apply `excludeTypes` filter (if specified)
4. Calculate priority scores
5. Sort and select highest

---

### AuditLogEntry (Append-only Log)

Structured log entry for observability. Stored as JSON Lines in `~/.mcp-git-issue-priority/logs/`.

```typescript
interface AuditLogEntry {
  timestamp: string;        // ISO 8601
  level: 'info' | 'warn' | 'error';
  tool: string;             // MCP tool name
  sessionId: string;        // Session UUID
  repoFullName?: string;    // "owner/repo"
  issueNumber?: number;
  phase?: WorkflowPhase;
  duration?: number;        // Milliseconds
  outcome: 'success' | 'failure' | 'skipped';
  error?: string;
  metadata?: Record<string, unknown>;
}
```

**File Location**: `~/.mcp-git-issue-priority/logs/audit-{YYYY-MM-DD}.jsonl`

**Retention**: 30 days minimum (per constitution)

---

## Label Schema

Required labels that the MCP ensures exist in target repositories:

### Priority Labels
| Name | Color | Description |
|------|-------|-------------|
| `priority:critical` | `#b60205` | Production down, security vulnerability, data loss |
| `priority:high` | `#d93f0b` | Major feature blocked, significant user impact |
| `priority:medium` | `#fbca04` | Normal feature work, non-blocking improvements |
| `priority:low` | `#0e8a16` | Nice-to-have, minor improvements, tech debt |

### Type Labels
| Name | Color | Description |
|------|-------|-------------|
| `type:bug` | `#d73a4a` | Defect in existing functionality |
| `type:feature` | `#a2eeef` | New capability or enhancement |
| `type:chore` | `#fef2c0` | Maintenance, refactoring, dependencies |
| `type:docs` | `#0075ca` | Documentation only changes |

### Status Labels
| Name | Color | Description |
|------|-------|-------------|
| `status:backlog` | `#cfd3d7` | Not yet started |
| `status:in-progress` | `#0e8a16` | Actively being worked (locked) |
| `status:in-review` | `#fbca04` | PR open, awaiting review |
| `status:blocked` | `#b60205` | Cannot proceed, requires input |

---

## File System Layout

```
~/.mcp-git-issue-priority/
├── locks/
│   └── {owner}_{repo}_{issue_number}.lock
├── workflow/
│   └── {owner}_{repo}_{issue_number}.json
├── logs/
│   └── audit-{YYYY-MM-DD}.jsonl
└── config.json (optional - for custom settings)
```
