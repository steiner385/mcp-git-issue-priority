# Tasks: MCP GitHub Issue Priority Server

**Input**: Design documents from `/specs/001-mcp-issue-priority/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Tests included per constitution principle V (Test-First Discipline) and plan.md.

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4, US5)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root (per plan.md)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and TypeScript/MCP structure

- [X] T001 Create project directory structure per plan.md in src/tools/, src/services/, src/models/, src/config/
- [X] T002 Initialize TypeScript project with package.json (type: module, bin entry for CLI)
- [X] T003 [P] Configure tsconfig.json for ES2022, Node16 module resolution
- [X] T004 [P] Install dependencies: @modelcontextprotocol/sdk, @octokit/rest, @octokit/plugin-throttling, @octokit/plugin-retry, proper-lockfile, zod
- [X] T005 [P] Install dev dependencies: typescript, vitest, @types/node
- [X] T006 [P] Configure ESLint and Prettier for TypeScript

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure shared by ALL user stories

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Models (Shared Data Types)

- [X] T007 [P] Create Issue model and Label types in src/models/issue.ts
- [X] T008 [P] Create Lock model with validation in src/models/lock.ts
- [X] T009 [P] Create WorkflowState model with phase enum in src/models/workflow-state.ts
- [X] T010 [P] Create PriorityScore model with calculation types in src/models/priority-score.ts
- [X] T011 [P] Create SelectionFilter model in src/models/selection-filter.ts
- [X] T012 [P] Create AuditLogEntry model in src/models/audit-log.ts

### Services (Core Business Logic)

- [X] T013 Implement GitHubService with Octokit client setup in src/services/github.ts
- [X] T014 Implement AuditLogger with JSON Lines output in src/services/logging.ts
- [X] T015 Implement ConfigService for paths (~/.mcp-git-issue-priority/) in src/config/index.ts

### MCP Server Entry Point

- [X] T016 Create MCP server bootstrap with StdioServerTransport in src/index.ts

**Checkpoint**: Foundation ready - models, GitHub client, logging, config available for all stories

---

## Phase 3: User Story 1 - Create Properly Tagged Issue (Priority: P1) 🎯 MVP

**Goal**: Create GitHub issues with mandatory priority/type labels and standard template

**Independent Test**: Create issue via MCP tool, verify in GitHub with correct labels

### Tests for User Story 1

- [X] T017 [P] [US1] Unit test for label creation logic in tests/unit/github-labels.test.ts
- [X] T018 [P] [US1] Unit test for issue body template formatting in tests/unit/issue-template.test.ts
- [ ] T019 [US1] Integration test for create_issue tool in tests/integration/create-issue.test.ts

### Implementation for User Story 1

- [X] T020 [US1] Add ensureLabelsExist method to GitHubService in src/services/github.ts
- [X] T021 [US1] Add createIssue method to GitHubService in src/services/github.ts
- [X] T022 [US1] Add formatIssueBody helper for template structure in src/services/github.ts
- [X] T023 [US1] Implement create_issue MCP tool with Zod schema in src/tools/create-issue.ts
- [X] T024 [US1] Register create_issue tool in MCP server in src/index.ts
- [X] T025 [US1] Add audit logging for issue creation in src/tools/create-issue.ts

**Checkpoint**: US1 complete - can create properly tagged issues

---

## Phase 4: User Story 2 - Select Next Priority Issue (Priority: P1) 🎯 MVP

**Goal**: Concurrency-safe selection with file locking and deterministic priority scoring

**Independent Test**: Run two concurrent selections, verify different issues selected

### Tests for User Story 2

- [X] T026 [P] [US2] Unit test for priority score calculation in tests/unit/priority.test.ts
- [X] T027 [P] [US2] Unit test for selection filter logic in tests/unit/filter.test.ts
- [X] T028 [US2] Unit test for lock acquisition with proper-lockfile in tests/unit/locking.test.ts
- [ ] T029 [US2] Concurrent session test for lock contention in tests/concurrent/lock-contention.test.ts
- [ ] T030 [US2] Integration test for select_next_issue tool in tests/integration/select-issue.test.ts

### Implementation for User Story 2

- [X] T031 [US2] Implement calculatePriorityScore function in src/services/priority.ts
- [X] T032 [US2] Implement applyFilters function in src/services/priority.ts
- [X] T033 [US2] Implement sortByPriority function with tiebreaker in src/services/priority.ts
- [X] T034 [US2] Implement LockingService with proper-lockfile in src/services/locking.ts
- [X] T035 [US2] Add acquireLock method with PID tracking in src/services/locking.ts
- [X] T036 [US2] Add isLockStale method with process.kill(pid,0) check in src/services/locking.ts
- [X] T037 [US2] Add listOpenIssues method to GitHubService in src/services/github.ts
- [X] T038 [US2] Add updateIssueLabel method to GitHubService in src/services/github.ts
- [X] T039 [US2] Implement WorkflowService with state file management in src/services/workflow.ts
- [X] T040 [US2] Add createWorkflowState method in src/services/workflow.ts
- [X] T041 [US2] Implement select_next_issue MCP tool in src/tools/select-next-issue.ts
- [X] T042 [US2] Register select_next_issue tool in MCP server in src/index.ts
- [X] T043 [US2] Implement list_backlog MCP tool (read-only) in src/tools/list-backlog.ts
- [X] T044 [US2] Register list_backlog tool in MCP server in src/index.ts

**Checkpoint**: US1 + US2 complete - MVP: create issues and select next with concurrency safety

---

## Phase 5: User Story 3 - Guided Workflow (Priority: P2)

**Goal**: 8-phase workflow with transition validation and branch/PR creation

**Independent Test**: Select issue, advance through all phases to PR creation

### Tests for User Story 3

- [ ] T045 [P] [US3] Unit test for phase transition validation in tests/unit/workflow.test.ts
- [ ] T046 [P] [US3] Unit test for branch name generation in tests/unit/branch-name.test.ts
- [ ] T047 [US3] Integration test for advance_workflow tool in tests/integration/workflow.test.ts

### Implementation for User Story 3

- [X] T048 [US3] Add validatePhaseTransition method in src/services/workflow.ts
- [X] T049 [US3] Add recordPhaseTransition method in src/services/workflow.ts
- [X] T050 [US3] Add recordSkipJustification method in src/services/workflow.ts
- [X] T051 [US3] Add generateBranchName helper in src/services/workflow.ts
- [X] T052 [US3] Add createBranch method to GitHubService in src/services/github.ts
- [X] T053 [US3] Add createPullRequest method to GitHubService in src/services/github.ts
- [X] T054 [US3] Implement advance_workflow MCP tool in src/tools/advance-workflow.ts
- [X] T055 [US3] Register advance_workflow tool in MCP server in src/index.ts
- [X] T056 [US3] Implement get_workflow_status MCP tool in src/tools/get-workflow-status.ts
- [X] T057 [US3] Register get_workflow_status tool in MCP server in src/index.ts

**Checkpoint**: US3 complete - full workflow from selection to PR

---

## Phase 6: User Story 5 - Release Lock (Priority: P2)

**Goal**: Release locks on completion, abandonment, or merge

**Independent Test**: Lock issue, release with abandon, verify issue returns to backlog

### Tests for User Story 5

- [ ] T058 [P] [US5] Unit test for lock release logic in tests/unit/release-lock.test.ts
- [ ] T059 [US5] Integration test for release_lock tool in tests/integration/release-lock.test.ts

### Implementation for User Story 5

- [X] T060 [US5] Add releaseLock method in src/services/locking.ts
- [X] T061 [US5] Add deleteWorkflowState method in src/services/workflow.ts
- [X] T062 [US5] Implement release_lock MCP tool in src/tools/release-lock.ts
- [X] T063 [US5] Register release_lock tool in MCP server in src/index.ts

**Checkpoint**: US5 complete - can release locks and return issues to backlog

---

## Phase 7: User Story 4 - Force Claim (Priority: P3)

**Goal**: Take over locked issues with explicit confirmation and audit logging

**Independent Test**: Create stale lock, force claim, verify takeover logged

### Tests for User Story 4

- [ ] T064 [P] [US4] Unit test for force claim logic in tests/unit/force-claim.test.ts
- [ ] T065 [US4] Integration test for force_claim tool in tests/integration/force-claim.test.ts

### Implementation for User Story 4

- [X] T066 [US4] Add forceClaim method in src/services/locking.ts
- [X] T067 [US4] Add addIssueComment method to GitHubService in src/services/github.ts
- [X] T068 [US4] Implement force_claim MCP tool in src/tools/force-claim.ts
- [X] T069 [US4] Register force_claim tool in MCP server in src/index.ts

**Checkpoint**: All user stories complete

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Quality, documentation, and validation

- [X] T070 [P] Add error handling wrappers for all MCP tools in src/tools/*.ts
- [X] T071 [P] Add input validation with Zod for all tool schemas
- [ ] T072 [P] Create README.md with installation and usage instructions
- [ ] T073 [P] Create MCP configuration example in examples/claude-code-config.json
- [X] T074 Run all tests and fix any failures
- [ ] T075 Validate quickstart.md scenarios work end-to-end
- [ ] T076 [P] Add log rotation/cleanup for 30-day retention in src/services/logging.ts

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational - requires GitHubService, models
- **US2 (Phase 4)**: Depends on Foundational - requires LockingService, PriorityService
- **US3 (Phase 5)**: Depends on US2 (needs lock to advance workflow)
- **US5 (Phase 6)**: Depends on US2 (needs lock to release)
- **US4 (Phase 7)**: Depends on US2 (needs existing lock to force claim)
- **Polish (Phase 8)**: Depends on all user stories complete

### User Story Dependencies

```
US1 (P1) ─────────────────────────────────────────┐
                                                  │
US2 (P1) ──┬──► US3 (P2) ──► US5 (P2)            ├──► Polish
           │                                      │
           └──► US4 (P3) ─────────────────────────┘
```

- **US1**: Independent - can start immediately after Foundational
- **US2**: Independent - can start immediately after Foundational
- **US3**: Depends on US2 (needs select_next_issue to have a locked issue)
- **US4**: Depends on US2 (needs existing lock to force claim)
- **US5**: Depends on US2 (needs lock to release)

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Models before services
- Services before tools
- Tool implementation before registration

### Parallel Opportunities

**Phase 1 (Setup)**: T003, T004, T005, T006 can run in parallel
**Phase 2 (Foundational)**: T007-T012 (models) can run in parallel
**Phase 3 (US1)**: T017, T018 (tests) can run in parallel
**Phase 4 (US2)**: T026, T027 (tests) can run in parallel
**Phase 5 (US3)**: T045, T046 (tests) can run in parallel
**Phase 8 (Polish)**: T070, T071, T072, T073, T076 can run in parallel

---

## Parallel Example: Phase 2 Foundational Models

```bash
# Launch all model tasks in parallel:
Task: "Create Issue model in src/models/issue.ts"
Task: "Create Lock model in src/models/lock.ts"
Task: "Create WorkflowState model in src/models/workflow-state.ts"
Task: "Create PriorityScore model in src/models/priority-score.ts"
Task: "Create SelectionFilter model in src/models/selection-filter.ts"
Task: "Create AuditLogEntry model in src/models/audit-log.ts"
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL)
3. Complete Phase 3: US1 - Create Issue
4. Complete Phase 4: US2 - Select Next Issue
5. **STOP and VALIDATE**: Test issue creation and concurrency-safe selection
6. Demo: Create issues, select next issue, verify different sessions get different issues

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 → Test independently → Demo (create tagged issues)
3. Add US2 → Test independently → Demo (MVP! select with locking)
4. Add US3 → Test independently → Demo (full workflow)
5. Add US5 → Test independently → Demo (lock release)
6. Add US4 → Test independently → Demo (force claim edge case)
7. Polish → Final release

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: US1 (create_issue)
   - Developer B: US2 (select_next_issue, list_backlog)
3. After US2:
   - Developer A: US3 (advance_workflow)
   - Developer B: US5 (release_lock)
4. After US2:
   - Developer C: US4 (force_claim)
5. All: Polish phase

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Tests use Vitest (per plan.md)
- All file paths relative to repository root
- Lock files in ~/.mcp-git-issue-priority/locks/
- Workflow state in ~/.mcp-git-issue-priority/workflow/
- Logs in ~/.mcp-git-issue-priority/logs/
