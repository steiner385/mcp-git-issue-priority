import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService, type GitHubService } from '../services/github.js';
import { getLockingService, type LockingService } from '../services/locking.js';
import { getWorkflowService, type WorkflowService } from '../services/workflow.js';
import { getLogger, type AuditLogger } from '../services/logging.js';
import { resolveRepository } from '../utils/repository.js';

export interface ReleaseLockArgs {
  issueNumber: number;
  reason: 'completed' | 'abandoned' | 'merged';
  repository?: string;
}

export interface ReleaseLockDeps {
  github: Pick<GitHubService, 'updateIssueLabel' | 'closeIssue'>;
  locking: LockingService;
  workflow: Pick<WorkflowService, 'deleteWorkflowState' | 'getWorkflowState'>;
  logger: Pick<AuditLogger, 'info' | 'error'>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Pure handler for `release_lock`. Extracted so it can be unit-tested with
 * injected dependencies. `registerReleaseLockTool` wires the singletons.
 */
export async function handleReleaseLock(
  args: ReleaseLockArgs,
  deps: ReleaseLockDeps
): Promise<ToolResult> {
  const startTime = Date.now();
  const { github, locking, workflow, logger } = deps;

  const parsed = resolveRepository(args.repository);
  if (!parsed) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: "Repository required. Provide 'repository' argument or set GITHUB_REPOSITORY env var.", code: 'REPO_REQUIRED' }) }],
      isError: true,
    };
  }

  const { owner, repo } = parsed;
  const repoFullName = `${owner}/${repo}`;

  try {
    const lockData = await locking.readLockFile(owner, repo, args.issueNumber);
    if (!lockData) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Issue not locked', code: 'NOT_LOCKED' }) }],
        isError: true,
      };
    }

    const lockDuration = Math.floor((Date.now() - new Date(lockData.acquiredAt).getTime()) / 1000);

    const released = await locking.releaseLock(owner, repo, args.issueNumber);
    if (!released) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Issue not locked by this session', code: 'NOT_LOCKED' }) }],
        isError: true,
      };
    }

    // Preserve workflow state for `completed` (PR open, awaiting merge) and for
    // any in-flight phase (pr/review/merged) even when abandoning — the PR may
    // still exist on GitHub and another session could pick up the review.
    // Only wipe state on `abandoned` when work is genuinely pre-PR, and on
    // `merged` (issue is closed, no further selection needed).
    const IN_FLIGHT_PHASES = new Set(['pr', 'review', 'merged']);
    const currentState = await workflow.getWorkflowState(owner, repo, args.issueNumber);
    const isInFlight = currentState && IN_FLIGHT_PHASES.has(currentState.currentPhase);

    if (args.reason === 'merged') {
      await workflow.deleteWorkflowState(owner, repo, args.issueNumber);
    } else if (args.reason === 'abandoned' && !isInFlight) {
      await workflow.deleteWorkflowState(owner, repo, args.issueNumber);
    }
    // reason === 'completed' or (reason === 'abandoned' && isInFlight) → preserve state

    if (args.reason === 'abandoned') {
      await github.updateIssueLabel(owner, repo, args.issueNumber, ['status:backlog'], ['status:in-progress', 'status:in-review']);
    } else if (args.reason === 'completed') {
      await github.updateIssueLabel(owner, repo, args.issueNumber, ['status:in-review'], ['status:in-progress']);
    } else if (args.reason === 'merged') {
      await github.updateIssueLabel(owner, repo, args.issueNumber, [], ['status:in-progress', 'status:in-review']);
      await github.closeIssue(owner, repo, args.issueNumber);
    }

    const duration = Date.now() - startTime;
    await logger.info('release_lock', {
      repoFullName,
      issueNumber: args.issueNumber,
      duration,
      metadata: { reason: args.reason, lockDuration },
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          released: {
            issueNumber: args.issueNumber,
            reason: args.reason,
            duration: lockDuration,
          },
        }),
      }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await logger.error('release_lock', errorMessage, { repoFullName, issueNumber: args.issueNumber });
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: `GitHub API error: ${errorMessage}`, code: 'GITHUB_API_ERROR' }) }],
      isError: true,
    };
  }
}

export function registerReleaseLockTool(server: McpServer) {
  server.tool(
    'release_lock',
    'Release lock on an issue (abandon or complete)',
    {
      issueNumber: z.number().int().positive().describe('Issue number'),
      reason: z.enum(['completed', 'abandoned', 'merged']).describe('Release reason'),
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .optional()
        .describe("Repository in 'owner/repo' format"),
    },
    async (args) =>
      handleReleaseLock(args as ReleaseLockArgs, {
        github: getGitHubService(),
        locking: getLockingService(),
        workflow: getWorkflowService(),
        logger: getLogger(),
      })
  );
}
