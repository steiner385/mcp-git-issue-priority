import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getLockingService } from '../services/locking.js';
import { getWorkflowService } from '../services/workflow.js';
import { getLogger } from '../services/logging.js';

function parseRepository(repository?: string): { owner: string; repo: string } | null {
  if (!repository) return null;
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

const CONFIRMATION_STRING = 'I understand this may cause conflicts';

export function registerForceClaimTool(server: McpServer) {
  server.tool(
    'force_claim',
    'Force claim an issue that is locked by another session',
    {
      issueNumber: z.number().int().positive().describe('Issue number to claim'),
      confirmation: z.string().describe('Required confirmation string'),
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .optional()
        .describe("Repository in 'owner/repo' format"),
    },
    async (args) => {
      const startTime = Date.now();
      const logger = getLogger();
      const github = getGitHubService();
      const locking = getLockingService();
      const workflow = getWorkflowService();

      if (args.confirmation !== CONFIRMATION_STRING) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Confirmation string does not match', code: 'INVALID_CONFIRMATION' }) }],
          isError: true,
        };
      }

      const parsed = parseRepository(args.repository);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Repository is required', code: 'REPO_REQUIRED' }) }],
          isError: true,
        };
      }

      const { owner, repo } = parsed;
      const repoFullName = `${owner}/${repo}`;

      try {
        const result = await locking.forceClaim(owner, repo, args.issueNumber);

        if (!result.success) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error, code: 'LOCK_WRITE_FAILED' }) }],
            isError: true,
          };
        }

        await github.addIssueComment(
          owner,
          repo,
          args.issueNumber,
          `Issue claimed by new session (force claim). Previous holder: ${result.previousHolder?.sessionId ?? 'none'}`
        );

        let existingState = await workflow.getWorkflowState(owner, repo, args.issueNumber);
        if (!existingState) {
          existingState = await workflow.createWorkflowState(owner, repo, args.issueNumber, 'force_claim');
        }

        const duration = Date.now() - startTime;
        await logger.logToolCall('force_claim', 'success', {
          level: 'warn',
          repoFullName,
          issueNumber: args.issueNumber,
          duration,
          metadata: { previousSession: result.previousHolder?.sessionId ?? null },
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              claimed: {
                issueNumber: args.issueNumber,
                previousHolder: result.previousHolder
                  ? {
                      sessionId: result.previousHolder.sessionId,
                      acquiredAt: result.previousHolder.acquiredAt,
                      pid: result.previousHolder.pid,
                    }
                  : null,
              },
              lock: {
                sessionId: result.lock!.sessionId,
                acquiredAt: result.lock!.acquiredAt,
              },
            }),
          }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('force_claim', errorMessage, { repoFullName, issueNumber: args.issueNumber });
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Error: ${errorMessage}`, code: 'INTERNAL_ERROR' }) }],
          isError: true,
        };
      }
    }
  );
}
