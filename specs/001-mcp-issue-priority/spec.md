# Feature Specification: MCP GitHub Issue Priority Server

**Feature Branch**: `001-mcp-issue-priority`
**Created**: 2026-01-31
**Status**: Draft
**Input**: MCP server for GitHub issue prioritization with concurrency-safe selection, guided workflow enforcement, and automatic next-issue selection

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create Properly Tagged GitHub Issue (Priority: P1)

As a developer using an AI assistant, I want to create new GitHub issues with consistent priority and type labels so that issues are automatically prioritized in my backlog without manual tagging.

**Why this priority**: Issue creation is the entry point for all work. Without properly tagged issues, the prioritization and selection features cannot function. This is the foundation of the entire system.

**Independent Test**: Can be fully tested by creating an issue through the MCP and verifying it appears in GitHub with correct labels and structure, delivering immediate value as a standardized issue creation workflow.

**Acceptance Scenarios**:

1. **Given** a repository with the MCP configured, **When** I request to create an issue with title "Fix login timeout" and type "bug" and priority "high", **Then** the issue is created in GitHub with labels `type:bug`, `priority:high`, and `status:backlog`, and follows the standard issue template structure.

2. **Given** a repository without the required labels, **When** I create my first issue, **Then** the system automatically creates all required labels (priority:critical/high/medium/low, type:bug/feature/chore/docs, status:backlog/in-progress/in-review/blocked) before creating the issue.

3. **Given** a request to create an issue without specifying priority, **When** I provide only title and type, **Then** the system prompts for priority selection before proceeding (no default assumption).

---

### User Story 2 - Select Next Priority Issue with Concurrency Safety (Priority: P1)

As a developer running multiple AI assistant sessions on the same machine, I want to automatically select the highest-priority issue from my backlog without risk of two sessions selecting the same issue so that I can maximize productivity without coordination overhead.

**Why this priority**: This is the core differentiating feature - automatic, conflict-free issue selection. It directly addresses the primary pain point of duplicate work across sessions.

**Independent Test**: Can be fully tested by running two concurrent selection requests and verifying each session receives a different issue, delivering immediate value as a conflict-free work distribution system.

**Acceptance Scenarios**:

1. **Given** a backlog with issues of varying priorities, **When** I request the next issue, **Then** the system returns the issue with the highest priority score (calculated as: label points + age bonus + blocking multiplier).

2. **Given** two sessions on the same machine simultaneously requesting the next issue, **When** both requests arrive within milliseconds, **Then** each session receives a different issue due to local file locking, and both issues are marked `status:in-progress` in GitHub.

3. **Given** an issue is already marked `status:in-progress` in GitHub, **When** I request the next issue, **Then** that issue is excluded from consideration (cross-host protection).

4. **Given** two issues with identical priority scores, **When** I request the next issue, **Then** the system selects the issue with the lower issue number (older issue first - FIFO tiebreaker).

5. **Given** I want to focus on bugs only, **When** I request the next issue with filter `--type=bug`, **Then** only issues labeled `type:bug` are considered for selection.

---

### User Story 3 - Follow Guided Implementation Workflow (Priority: P2)

As a developer, I want the system to guide me through a structured workflow (research → branch → implement → test → commit → PR) so that I don't skip important steps and my changes are properly documented and tested.

**Why this priority**: While important for quality, the workflow enforcement builds on top of issue creation and selection. Users can still derive value from P1 stories without strict workflow enforcement.

**Independent Test**: Can be fully tested by selecting an issue and stepping through each workflow phase, verifying the system tracks progress and enforces phase ordering.

**Acceptance Scenarios**:

1. **Given** I have selected an issue, **When** I attempt to create a PR without running tests, **Then** the system blocks the action and requires either running tests or explicit override with logged justification.

2. **Given** I am in the "research" phase, **When** I request to advance to "branch" phase, **Then** the system creates a branch named `{issue_number}-{kebab-case-summary}` from the default branch.

3. **Given** I complete implementation and tests pass, **When** I create a PR, **Then** the PR automatically references the issue number, includes test evidence, and the issue label changes to `status:in-review`.

4. **Given** I want to skip the research phase, **When** I request to advance directly to branch, **Then** the system allows it but logs the skip with my justification.

---

### User Story 4 - Force Claim In-Progress Issue (Priority: P3)

As a developer, I want to take over an issue that another session has locked (due to stale lock or abandoned work) so that I can continue work without waiting for automatic lock expiration.

**Why this priority**: This is an edge case recovery mechanism. Most users will not need this in normal operation, but it's essential for handling exceptional situations.

**Independent Test**: Can be fully tested by creating a stale lock file and then force-claiming the issue, verifying the takeover is logged and previous holder is notified.

**Acceptance Scenarios**:

1. **Given** an issue is locked by another session, **When** I request to force claim it, **Then** the system asks for explicit confirmation that I understand this may cause conflicts.

2. **Given** I confirm force claim, **When** the takeover completes, **Then** the lock file is updated with my session, the action is logged with timestamp and previous holder info, and an issue comment is added for cross-host visibility.

---

### User Story 5 - Release Lock and Complete Issue (Priority: P2)

As a developer, I want the system to automatically release locks when I merge a PR or explicitly abandon work so that issues return to the backlog for others to pick up.

**Why this priority**: Lock release is critical for the system to function over time. Without proper release, issues would become permanently locked.

**Independent Test**: Can be fully tested by merging a PR and verifying the lock file is deleted and the issue label changes appropriately.

**Acceptance Scenarios**:

1. **Given** a PR for my locked issue is merged, **When** the merge completes, **Then** the local lock file is deleted, the issue is closed, and the workflow log records the completion.

2. **Given** I am working on an issue but need to stop, **When** I explicitly abandon the issue, **Then** the lock is released, the issue label reverts to `status:backlog`, and the action is logged.

3. **Given** a lock file exists but the process that created it is no longer running, **When** I request the next issue, **Then** the system detects the stale lock (via PID check) and allows claiming that issue.

---

### Edge Cases

- What happens when GitHub API is unavailable during issue creation? System queues the request locally and retries, or reports failure clearly without partial state.
- What happens when a user tries to select an issue in a repository they don't have write access to? System checks permissions before attempting selection and reports permission error.
- What happens when the lock timeout (30 minutes) expires while a session is still active? Lock remains valid as long as the session PID is alive; timeout only applies to orphaned locks.
- What happens when filters exclude all available issues? System reports "no issues match criteria" rather than selecting nothing silently.
- What happens when a user creates an issue with an invalid priority/type combination? System validates inputs and rejects invalid combinations before creating the issue.

## Requirements *(mandatory)*

### Functional Requirements

**Issue Creation**
- **FR-001**: System MUST create GitHub issues with mandatory priority label (critical/high/medium/low)
- **FR-002**: System MUST create GitHub issues with mandatory type label (bug/feature/chore/docs)
- **FR-003**: System MUST automatically apply `status:backlog` label to newly created issues
- **FR-004**: System MUST create required labels in a repository if they don't exist on first use
- **FR-005**: System MUST enforce the standard issue template structure (Summary, Context, Acceptance Criteria, Technical Notes)

**Issue Selection & Prioritization**
- **FR-006**: System MUST calculate priority score using: label points + age bonus (1 point/day, max 30) + blocking multiplier (1.5x)
- **FR-007**: System MUST use issue number ascending as tiebreaker for equal priority scores
- **FR-008**: System MUST exclude issues labeled `status:in-progress` from selection candidates
- **FR-009**: System MUST support include filters (`--type=bug,feature`) to narrow candidate pool
- **FR-010**: System MUST support exclude filters (`--exclude=docs`) to skip specific types
- **FR-011**: System MUST apply include filter before exclude filter when both are specified

**Concurrency & Locking**
- **FR-012**: System MUST acquire local file lock before claiming an issue
- **FR-013**: System MUST store lock files in `~/.mcp-git-issue-priority/locks/` directory
- **FR-014**: System MUST store PID, session ID, and timestamp in lock files
- **FR-015**: System MUST apply `status:in-progress` label immediately after successful lock acquisition
- **FR-016**: System MUST detect stale locks by checking if lock holder PID is still running
- **FR-017**: System MUST allow force claim with explicit user confirmation
- **FR-018**: System MUST release lock automatically upon PR merge, issue close, or explicit abandon

**Workflow Enforcement**
- **FR-019**: System MUST track workflow phase for each locked issue (selection → research → branch → implement → test → commit → PR → merge)
- **FR-020**: System MUST block PR creation when tests have not been run (with override option)
- **FR-021**: System MUST log all phase skips with user-provided justification
- **FR-022**: System MUST create branches following pattern `{issue_number}-{kebab-case-summary}`
- **FR-023**: System MUST require issue number reference in all PR titles and bodies

**Observability**
- **FR-024**: System MUST log all tool invocations with timestamp, tool name, parameters, and outcome
- **FR-025**: System MUST log lock acquisitions and releases with issue number, session ID, and duration
- **FR-026**: System MUST store logs in `~/.mcp-git-issue-priority/logs/` as JSON lines
- **FR-027**: System MUST retain logs for minimum 30 days and lock history for 90 days

### Key Entities

- **Issue**: GitHub issue with priority score, type, status, and optional blocking relationships. Key attributes: issue number, title, priority label, type label, status label, creation date, blocking issue numbers.

- **Lock**: Local file representing exclusive claim on an issue. Key attributes: issue number, holder PID, session ID, acquisition timestamp, associated repository.

- **WorkflowState**: Current phase of work on a locked issue. Key attributes: issue number, current phase, phase history with timestamps, skip justifications.

- **PriorityScore**: Calculated value determining selection order. Composed of: base points (from priority label), age bonus (days since creation), blocking multiplier (if blocks other issues).

- **SelectionFilter**: User-specified criteria for narrowing candidate pool. Key attributes: include types (whitelist), exclude types (blacklist).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can create a properly tagged issue in under 30 seconds of interaction time
- **SC-002**: Two concurrent sessions on the same machine never select the same issue (0% collision rate in testing)
- **SC-003**: Issue selection returns a result in under 5 seconds for repositories with up to 1000 open issues
- **SC-004**: 100% of created issues have valid priority and type labels upon creation
- **SC-005**: Workflow phase violations (e.g., PR without tests) are blocked in 100% of cases unless explicitly overridden
- **SC-006**: Lock release occurs within 60 seconds of PR merge or explicit abandon action
- **SC-007**: Stale lock detection correctly identifies 100% of orphaned locks (dead PIDs)
- **SC-008**: All MCP operations are logged with complete audit trail (timestamp, action, outcome)
- **SC-009**: Users can force-claim a locked issue and resume work in under 2 minutes
- **SC-010**: Priority calculation produces identical results for identical inputs across all sessions (deterministic)

## Assumptions

- Users have GitHub API access with write permissions to the target repository
- The MCP server runs on a POSIX-compatible system with file locking support (flock)
- AI assistants (Claude Code, etc.) can invoke MCP tools with structured parameters
- Users accept a small race condition window for cross-host scenarios (documented limitation)
- Session IDs are unique within a single machine (UUID or similar)
- Default lock timeout of 30 minutes is appropriate for most coding sessions
