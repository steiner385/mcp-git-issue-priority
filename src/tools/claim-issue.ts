import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LockingService, getLockingService } from '../services/locking.js';
import { WorkflowService, getWorkflowService } from '../services/workflow.js';
import { AuditLogger, getLogger } from '../services/logging.js';
import { resolveRepository } from '../utils/repository.js';

/**
 * `claim_issue` is a lightweight lock acquisition for callers who already know
 * which issue they intend to work on (typed it, picked it from `gh issue list`,
 * came from a slash command, etc.).
 *
 * Unlike `select_next_issue` it does NOT:
 *   - Score / re-prioritize the backlog
 *   - Hit the GitHub API
 *   - Mutate issue labels
 *
 * It DOES create a workflow state (research phase) if one does not already exist.
 * Without a state file, `select_next_issue` cannot detect that this issue is
 * in-flight and will re-select it from the backlog — producing duplicate work.
 * An existing state file (e.g. at pr/review phase) is preserved unchanged.
 *
 * Sweeps stale locks before attempting acquisition so a session that crashed
 * without releasing doesn't permanently block its issue.
 */

export interface ClaimIssueArgs {
  issueNumber: number;
  repository?: string;
}

export interface ClaimIssueDeps {
  locking: LockingService;
  workflow: WorkflowService;
  logger: Pick<AuditLogger, 'info' | 'warn' | 'error'>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Pure handler for `claim_issue`. Extracted from the tool registration so it
 * can be unit-tested with injected dependencies. `registerClaimIssueTool`
 * is a thin shell that wires the singleton services.
 */
export async function handleClaimIssue(
  args: ClaimIssueArgs,
  deps: ClaimIssueDeps
): Promise<ToolResult> {
  const startTime = Date.now();
  const { locking, workflow, logger } = deps;

  const parsed = resolveRepository(args.repository);
  if (!parsed) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error:
              "Repository required. Provide 'repository' argument or set GITHUB_REPOSITORY env var.",
            code: 'REPO_REQUIRED',
          }),
        },
      ],
      isError: true,
    };
  }

  const { owner, repo } = parsed;
  const repoFullName = `${owner}/${repo}`;

  try {
    // Opportunistic sweep so a crashed session does not permanently block
    // its issue. Cheap when the dir is small; bounded by listLocks.
    const swept = await locking.sweepStaleLocks();

    const result = await locking.acquireLock(owner, repo, args.issueNumber);

    if (result.success) {
      // Ensure a workflow state exists so select_next_issue can detect this
      // issue is in-flight and skip it. Preserve any existing state (e.g. pr
      // phase from a prior session) — only create if the file is absent.
      const existingState = await workflow.getWorkflowState(owner, repo, args.issueNumber);
      if (!existingState) {
        await workflow.createWorkflowState(owner, repo, args.issueNumber, 'claim_issue');
      }

      const duration = Date.now() - startTime;
      await logger.info('claim_issue', {
        repoFullName,
        issueNumber: args.issueNumber,
        duration,
        metadata: { staleSwept: swept },
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              issueNumber: args.issueNumber,
              lock: {
                sessionId: result.lock!.sessionId,
                acquiredAt: result.lock!.acquiredAt,
              },
              staleSwept: swept,
            }),
          },
        ],
      };
    }

    // LOCK_HELD — surface the current holder so the caller can decide
    // whether to wait, force-claim, or move on.
    const holder = await locking.getLockHolder(owner, repo, args.issueNumber);
    await logger.warn('claim_issue', 'Issue already locked', {
      repoFullName,
      issueNumber: args.issueNumber,
      metadata: { holderSessionId: holder?.sessionId, isStale: holder?.isStale },
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: result.error,
            code: result.code ?? 'LOCK_HELD',
            issueNumber: args.issueNumber,
            holder: holder
              ? { sessionId: holder.sessionId, isStale: holder.isStale }
              : null,
          }),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await logger.error('claim_issue', errorMessage, {
      repoFullName,
      issueNumber: args.issueNumber,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Lock service error: ${errorMessage}`,
            code: 'LOCK_SERVICE_ERROR',
          }),
        },
      ],
      isError: true,
    };
  }
}

export function registerClaimIssueTool(server: McpServer) {
  server.tool(
    'claim_issue',
    'Acquire a lock on a specific issue without going through priority selection. Use before opening a branch when you already know the issue number.',
    {
      issueNumber: z.number().int().positive().describe('Issue number to claim'),
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .optional()
        .describe("Repository in 'owner/repo' format"),
    },
    async (args) =>
      handleClaimIssue(args, {
        locking: getLockingService(),
        workflow: getWorkflowService(),
        logger: getLogger(),
      })
  );
}
