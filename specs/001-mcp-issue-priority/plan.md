# Implementation Plan: MCP GitHub Issue Priority Server

**Branch**: `001-mcp-issue-priority` | **Date**: 2026-01-31 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-mcp-issue-priority/spec.md`

## Summary

Build an MCP (Model Context Protocol) server that enables AI assistants to manage GitHub issues with automatic prioritization, concurrency-safe selection across multiple sessions, and guided workflow enforcement. The server exposes tools for issue creation with proper tagging, deterministic next-issue selection with file-based locking, and workflow phase tracking from selection through PR merge.

## Technical Context

**Language/Version**: TypeScript 5.x with Node.js 20 LTS
**Primary Dependencies**: @modelcontextprotocol/sdk, @octokit/rest (GitHub API), proper-lockfile (file locking)
**Storage**: File-based (JSON files for locks, workflow state, logs in `~/.mcp-git-issue-priority/`)
**Testing**: Vitest (unit + integration), with concurrent session simulation for lock testing
**Target Platform**: POSIX-compatible systems (Linux, macOS) with Node.js runtime
**Project Type**: Single project (MCP server library + CLI for testing)
**Performance Goals**: Issue selection <5s for repos with 1000 issues; lock acquisition <100ms
**Constraints**: Must work offline for lock checking; GitHub API calls should be batched where possible
**Scale/Scope**: Single user with multiple concurrent sessions; repositories up to 10k issues

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| I. MCP-First Architecture | ✅ PASS | All features exposed as MCP tools: `create_issue`, `select_next_issue`, `advance_workflow`, `release_lock`, `force_claim` |
| II. Concurrency-Safe Selection | ✅ PASS | Dual-layer locking: file locks (proper-lockfile) + GitHub labels; global lock directory `~/.mcp-git-issue-priority/locks/` |
| III. Prioritization Framework | ✅ PASS | Deterministic scoring: label points + age bonus + blocking multiplier; FIFO tiebreaker |
| IV. Guided Workflow Enforcement | ✅ PASS | 8-phase workflow tracked in WorkflowState; phase transitions via explicit tool calls |
| V. Test-First Discipline | ✅ PASS | Vitest test suite; concurrent lock tests; integration tests with mock GitHub API |
| VI. Observability and Auditability | ✅ PASS | JSON Lines logging to `~/.mcp-git-issue-priority/logs/`; 30-day retention |

**Gate Status**: PASSED - All 6 principles satisfied. Proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/001-mcp-issue-priority/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (MCP tool schemas)
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
src/
├── tools/               # MCP tool implementations
│   ├── create-issue.ts
│   ├── select-next-issue.ts
│   ├── advance-workflow.ts
│   ├── release-lock.ts
│   └── force-claim.ts
├── services/            # Business logic
│   ├── github.ts        # GitHub API wrapper
│   ├── priority.ts      # Priority calculation
│   ├── locking.ts       # File lock management
│   ├── workflow.ts      # Workflow state machine
│   └── logging.ts       # Audit logging
├── models/              # Data types and validation
│   ├── issue.ts
│   ├── lock.ts
│   ├── workflow-state.ts
│   └── priority-score.ts
├── config/              # Configuration management
│   └── index.ts
└── index.ts             # MCP server entry point

tests/
├── unit/                # Unit tests for services
├── integration/         # Full workflow tests
└── concurrent/          # Lock contention tests
```

**Structure Decision**: Single project structure selected. This is an MCP server (library) with no separate frontend/backend split. The `src/tools/` directory maps directly to MCP tool definitions, while `src/services/` contains the business logic that tools orchestrate.

## Complexity Tracking

> No violations to justify - all constitution principles satisfied with straightforward implementations.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| N/A | N/A | N/A |
