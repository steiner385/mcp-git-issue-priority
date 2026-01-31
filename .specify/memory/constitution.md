<!--
SYNC IMPACT REPORT
==================
Version change: 0.0.0 → 1.0.0 (Initial ratification)
Modified principles: N/A (initial version)
Added sections:
  - Core Principles (6 principles)
  - Issue Lifecycle Standards
  - Development Workflow
  - Governance
Removed sections: N/A (initial version)
Templates requiring updates:
  - .specify/templates/plan-template.md: ✅ Compatible (Constitution Check section exists)
  - .specify/templates/spec-template.md: ✅ Compatible (priority-based user stories align)
  - .specify/templates/tasks-template.md: ✅ Compatible (phase structure aligns)
Follow-up TODOs: None
==================
-->

# MCP GitHub Issue Priority Constitution

## Core Principles

### I. MCP-First Architecture

All functionality MUST be exposed as MCP tools callable by AI assistants. The server
MUST NOT require direct CLI invocation for core operations.

**Non-negotiables:**
- Every user-facing capability exposes an MCP tool with typed parameters
- Tools return structured responses (JSON) for machine parsing
- Human-readable output is secondary; structured data is primary
- Tool names follow verb-noun convention: `create_issue`, `select_next_issue`, `lock_issue`

**Rationale:** MCP tools enable AI assistants (Claude Code, etc.) to orchestrate
issue workflows without manual intervention, which is the core value proposition.

### II. Concurrency-Safe Issue Selection

Issue selection MUST prevent duplicate work through a dual-layer locking strategy:
1. **GitHub label layer** (`status:in-progress`) - cross-host visibility, advisory
2. **Local file lock layer** - same-machine atomic protection

**Non-negotiables:**
- Selection algorithm MUST first exclude issues labeled `status:in-progress`
- Issue selection MUST then acquire a local exclusive lock before claiming
- Locks MUST use file-based advisory locking (flock/lockfile) for local sessions
- Lock state MUST be persisted to survive session restarts
- Lock timeout: 30 minutes default (configurable)
- Stale lock detection MUST exist with manual override capability
- Lock release MUST be automatic upon issue completion, PR merge, or explicit abandon
- Upon successful lock acquisition, MUST immediately apply `status:in-progress` label

**Implementation requirements:**
- Lock file location: `~/.mcp-git-issue-priority/locks/` (global, single source of truth)
- Lock file format: `{issue_number}.lock` containing PID, session ID, timestamp
- Selection sequence: filter by label → acquire local lock → apply label → proceed

**Force claim behavior:**
- Users MAY force claim an issue that is locked or labeled `status:in-progress`
- Force claim MUST require explicit user confirmation ("I understand this may conflict")
- Force claim MUST be logged with: timestamp, user, issue number, previous holder (if known)
- Force claim MUST update the lock file and GitHub label to reflect new ownership
- Recommended: add issue comment noting the takeover for cross-host visibility

**Known limitation:** A race condition window exists between hosts when two sessions
simultaneously select an unlabeled issue. The GitHub label update is not atomic with
selection. Mitigation: keep lock timeout short; label application happens immediately
after local lock; users on different hosts should coordinate via issue comments.

**Rationale:** Local file locks provide atomic same-machine protection. GitHub labels
provide cross-host visibility. The combination minimizes (but cannot eliminate)
cross-host races without requiring external coordination infrastructure.

### III. Prioritization Framework

Issues MUST be tagged and scored using a consistent prioritization system that
enables deterministic "next issue" selection.

**Non-negotiables:**
- Every created issue MUST have priority label (`priority:critical`, `priority:high`,
  `priority:medium`, `priority:low`)
- Every created issue MUST have category label (`type:bug`, `type:feature`,
  `type:chore`, `type:docs`)
- Priority calculation MUST be deterministic: same inputs → same priority order
- Priority factors MUST include: label priority, age, blocking status, assignee availability

**Default priority weights:**
- `priority:critical` = 1000 points
- `priority:high` = 100 points
- `priority:medium` = 10 points
- `priority:low` = 1 point
- Age bonus: +1 point per day since creation (max +30)
- Blocking multiplier: 1.5x if issue blocks others
- Tiebreaker: Issue number ascending (oldest first - FIFO)

**Selection filtering:**
- Users MAY specify include filters: `--type=bug,feature` (only these types)
- Users MAY specify exclude filters: `--exclude=docs,chore` (skip these types)
- Filters apply BEFORE priority calculation (narrowing the candidate pool)
- If both include and exclude specified, include is applied first, then exclude
- Default (no filters): all types eligible for selection

**Rationale:** Deterministic prioritization ensures consistent behavior and allows
users to understand and predict which issue will be selected next.

### IV. Guided Workflow Enforcement

The MCP MUST enforce a structured workflow for issue implementation that prevents
incomplete or poorly-integrated changes.

**Workflow phases (in order):**
1. **Selection** - Lock and claim issue from backlog
2. **Research** - Read issue, linked PRs, related code; summarize understanding
3. **Branch** - Create feature branch from default branch (`{issue_number}-{slug}`)
4. **Implementation** - Write code following project conventions
5. **Local Testing** - Run project test suite; MUST pass before proceeding
6. **Commit** - Atomic commits with conventional commit messages referencing issue
7. **PR Creation** - Open PR with issue reference, description, test evidence
8. **Review/Merge** - Await review; merge upon approval; release lock

**Non-negotiables:**
- Workflow phase transitions MUST be explicit tool calls
- Skipping phases MUST require explicit override with justification logged
- Failed tests MUST block PR creation (override available but logged)
- PR MUST reference the originating issue number

**Rationale:** Enforced workflow prevents "cowboy coding" where issues are marked
done without proper testing or documentation.

### V. Test-First Discipline

Changes introduced through this MCP MUST follow test-first practices when the
project has an existing test suite.

**Non-negotiables:**
- Before implementation: check if project has test infrastructure
- If tests exist: new functionality SHOULD have corresponding tests
- Test execution MUST happen before PR creation
- Test failures MUST be reported with clear diagnostics
- Test skip MUST require explicit user confirmation

**Rationale:** The MCP manages issue-to-merge lifecycle; ensuring tests pass
prevents introducing regressions through automated workflows.

### VI. Observability and Auditability

All MCP operations MUST be logged for debugging multi-session scenarios and
understanding issue history.

**Non-negotiables:**
- Every tool invocation MUST log: timestamp, tool name, parameters, outcome
- Lock acquisition/release MUST log: issue number, session ID, duration
- Workflow phase transitions MUST log: issue number, from_phase, to_phase
- Log location: `~/.mcp-git-issue-priority/logs/` (global, consistent with lock storage)
- Log format: JSON lines for machine parsing

**Retention:**
- Logs retained for 30 days minimum
- Lock history retained for 90 days (for debugging conflicts)

**Rationale:** When multiple sessions interact with the same repository, logs
are essential for debugging "why was this issue locked?" scenarios.

## Issue Lifecycle Standards

### Required Labels

The MCP MUST create/verify these labels exist in target repositories:

**Priority labels:**
- `priority:critical` - Production down, security vulnerability, data loss risk
- `priority:high` - Major feature blocked, significant user impact
- `priority:medium` - Normal feature work, non-blocking improvements
- `priority:low` - Nice-to-have, minor improvements, tech debt

**Type labels:**
- `type:bug` - Defect in existing functionality
- `type:feature` - New capability or enhancement
- `type:chore` - Maintenance, refactoring, dependency updates
- `type:docs` - Documentation only changes

**Status labels (managed by workflow):**
- `status:backlog` - Not yet started
- `status:in-progress` - Actively being worked (locked)
- `status:in-review` - PR open, awaiting review
- `status:blocked` - Cannot proceed, requires input

### Issue Template

Created issues MUST follow this structure:
```markdown
## Summary
[One-line description]

## Context
[Why this issue matters, background information]

## Acceptance Criteria
- [ ] [Specific, testable criterion 1]
- [ ] [Specific, testable criterion 2]

## Technical Notes
[Implementation hints, relevant files, dependencies]
```

## Development Workflow

### Workflow State Machine

```
[backlog] --select--> [locked/researching] --branch--> [implementing]
    ^                                                        |
    |                                                        v
[abandoned] <--abandon-- [implementing] --test--> [testing]
                                                        |
                                                        v
                              [merged] <--merge-- [in-review] <--pr-- [testing]
```

### Branch Naming

Format: `{issue_number}-{kebab-case-summary}`
Example: `42-add-user-authentication`

### Commit Messages

Format: `{type}({scope}): {description} (#{issue_number})`
Example: `feat(auth): add JWT token validation (#42)`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

### PR Requirements

- Title: `{type}: {description} (#{issue_number})`
- Body MUST include: Summary, Test Evidence, Issue Reference
- MUST pass CI checks before merge
- MUST have at least one approval (if required by repo settings)

## Governance

### Constitution Authority

This constitution supersedes ad-hoc practices. All MCP tool implementations
MUST comply with these principles. Violations require explicit documentation
and approval before merging.

### Amendment Process

1. Propose amendment via PR to this file
2. Document rationale for change
3. Assess impact on existing tools (breaking vs additive)
4. Version bump according to semantic versioning:
   - MAJOR: Principle removal, breaking workflow changes
   - MINOR: New principles, expanded guidance
   - PATCH: Clarifications, typo fixes
5. Update dependent templates if affected
6. Merge upon approval

### Compliance Review

- All PRs introducing new MCP tools MUST cite relevant constitution principles
- Code review MUST verify principle compliance
- Periodic audit (quarterly) to ensure tools remain compliant

### Guidance Reference

For runtime development guidance and implementation details beyond this
constitution, refer to project README and inline code documentation.

## Clarifications

### Session 2026-01-31

- Q: Should lock storage be global or project-local? → A: Global only (`~/.mcp-git-issue-priority/locks/`)
- Q: How to break ties when priority scores are equal? → A: Issue number ascending (oldest first - FIFO)
- Q: What should the default lock timeout be? → A: 30 minutes; rely on `status:in-progress` label for cross-host protection (acknowledged race condition limitation)
- Q: Can users force claim locked/in-progress issues? → A: Yes, with explicit confirmation and audit logging
- Q: Should selection support filtering by issue type? → A: Yes, both include (`--type=`) and exclude (`--exclude=`) filters

**Version**: 1.1.0 | **Ratified**: 2026-01-31 | **Last Amended**: 2026-01-31
