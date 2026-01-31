# Research: MCP GitHub Issue Priority Server

**Date**: 2026-01-31
**Branch**: 001-mcp-issue-priority

## Technology Decisions

### 1. MCP Server Implementation

**Decision**: Use `@modelcontextprotocol/sdk` with the high-level `McpServer` API

**Rationale**:
- Official Anthropic SDK with TypeScript-first design
- High-level `registerTool` API provides type-safe tool definitions with Zod schemas
- Built-in error handling patterns (`isError: true` for tool errors vs `McpError` for protocol errors)
- STDIO transport is the standard for local MCP servers

**Alternatives Considered**:
- Lower-level `Server` class: More control but more boilerplate; rejected for simplicity
- Python SDK: Viable but TypeScript SDK is more mature and better documented

**Key Patterns**:
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "mcp-issue-priority", version: "1.0.0" });

server.registerTool(
  "create_issue",
  {
    description: "Create a GitHub issue with priority and type labels",
    inputSchema: {
      title: z.string(),
      priority: z.enum(["critical", "high", "medium", "low"]),
      type: z.enum(["bug", "feature", "chore", "docs"]),
    },
  },
  async ({ title, priority, type }) => {
    // Implementation
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);
```

**Critical Note**: Never use `console.log()` in STDIO servers - it corrupts JSON-RPC messages. Use `console.error()` or a stderr logger.

---

### 2. File Locking Strategy

**Decision**: Use `proper-lockfile` for cross-process file locking

**Rationale**:
- Uses `mkdir` strategy (atomic on all filesystems including NFS)
- Built-in stale lock detection via continuous mtime updates
- Active maintenance (~3.9M weekly downloads)
- Pure JavaScript - no native compilation required
- Works on Linux, macOS, and Windows

**Alternatives Considered**:
- `lockfile` (npm): Repository archived since 2021; rejected due to maintenance status
- `fs-ext` (native flock): Broken on Windows, doesn't work over NFS; rejected for portability
- `pidlock`: Linux-only (`/proc` filesystem); rejected for portability

**Configuration for Issue Selection**:
```typescript
const LOCK_OPTIONS = {
  stale: 30000,           // 30 seconds (matches constitution timeout)
  update: 10000,          // Update mtime every 10 seconds
  retries: {
    retries: 5,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 5000,
    randomize: true
  },
  onCompromised: (err) => {
    console.error('Lock compromised - aborting:', err.message);
    throw err;
  }
};
```

**PID Tracking Enhancement**:
For additional stale lock detection, store PID in lock metadata and check with `process.kill(pid, 0)`:
```typescript
async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
```

---

### 3. GitHub API Integration

**Decision**: Use `@octokit/rest` with throttling and retry plugins

**Rationale**:
- Official GitHub SDK with comprehensive TypeScript types
- Plugin architecture allows adding rate limiting and retry logic
- Pagination support via `octokit.paginate()`

**Required Plugins**:
- `@octokit/plugin-throttling`: Handles rate limit responses with automatic retry
- `@octokit/plugin-retry`: Retries server errors (5xx)
- `@octokit/request-error`: Typed error handling

**Configuration**:
```typescript
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";

const MyOctokit = Octokit.plugin(throttling, retry);

const octokit = new MyOctokit({
  auth: process.env.GITHUB_TOKEN,
  throttle: {
    onRateLimit: (retryAfter, options, octokit, retryCount) => {
      if (retryCount < 2) return true;
      return false;
    },
    onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
      if (retryCount < 1) return true;
      return false;
    },
  },
  retry: {
    doNotRetry: [400, 401, 403, 404, 422],
    retries: 3,
  },
});
```

**Key Patterns**:
- Always use `octokit.paginate()` for listing (repos can have thousands of issues)
- Filter out PRs: `issues.filter(issue => !issue.pull_request)`
- Handle 422 for "label already exists" when creating labels
- Handle 404 when removing labels that aren't on the issue

---

### 4. Testing Strategy

**Decision**: Use Vitest with concurrent session simulation

**Rationale**:
- Fast execution with native ESM support
- Compatible with TypeScript out of the box
- Good mocking capabilities for GitHub API

**Test Categories**:
1. **Unit tests**: Priority calculation, filter logic, workflow state machine
2. **Integration tests**: Full tool invocation with mocked GitHub API
3. **Concurrent tests**: Multiple processes acquiring locks simultaneously

**Concurrent Lock Testing Pattern**:
```typescript
import { fork } from 'child_process';

test('two processes cannot acquire same lock', async () => {
  const results = await Promise.all([
    forkAndAcquireLock('session-1'),
    forkAndAcquireLock('session-2'),
  ]);

  // One should succeed, one should fail or get different issue
  expect(results.filter(r => r.success)).toHaveLength(2);
  expect(results[0].issueId).not.toBe(results[1].issueId);
});
```

---

### 5. Logging Strategy

**Decision**: JSON Lines format to `~/.mcp-git-issue-priority/logs/`

**Rationale**:
- Machine-parseable for debugging multi-session scenarios
- Easy to grep/filter by timestamp, tool, or issue number
- Constitution requires 30-day retention minimum

**Log Structure**:
```typescript
interface LogEntry {
  timestamp: string;      // ISO 8601
  level: 'info' | 'warn' | 'error';
  tool: string;           // MCP tool name
  sessionId: string;      // UUID per session
  issueNumber?: number;
  phase?: string;         // Workflow phase
  duration?: number;      // ms
  outcome: 'success' | 'failure' | 'skipped';
  error?: string;
  metadata?: Record<string, unknown>;
}
```

**Implementation**: Use a simple file-append logger (no external dependencies):
```typescript
import fs from 'fs/promises';
import path from 'path';

class AuditLogger {
  private logFile: string;

  constructor(baseDir: string) {
    const date = new Date().toISOString().split('T')[0];
    this.logFile = path.join(baseDir, `audit-${date}.jsonl`);
  }

  async log(entry: Omit<LogEntry, 'timestamp'>) {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
    await fs.appendFile(this.logFile, line + '\n');
  }
}
```

---

## Dependencies Summary

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.25.0 | MCP server implementation |
| `@octokit/rest` | ^21.0.0 | GitHub API client |
| `@octokit/plugin-throttling` | ^9.0.0 | Rate limit handling |
| `@octokit/plugin-retry` | ^7.0.0 | Retry on server errors |
| `@octokit/request-error` | ^6.0.0 | Typed error handling |
| `proper-lockfile` | ^4.1.0 | Cross-process file locking |
| `zod` | ^3.25.0 | Schema validation for MCP tools |

**Dev Dependencies**:
| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.4.0 | TypeScript compiler |
| `vitest` | ^2.0.0 | Testing framework |
| `@types/node` | ^20.0.0 | Node.js type definitions |

---

## Open Questions Resolved

| Question | Resolution |
|----------|------------|
| MCP tool definition approach? | High-level `McpServer.registerTool` with Zod schemas |
| File locking library? | `proper-lockfile` with PID tracking enhancement |
| GitHub API error handling? | Throttling + retry plugins with typed error catching |
| Test framework? | Vitest with fork-based concurrent tests |
| Logging format? | JSON Lines with structured entries |

---

## References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)
- [Octokit REST.js](https://octokit.github.io/rest.js/v22/)
- [Vitest](https://vitest.dev/)
