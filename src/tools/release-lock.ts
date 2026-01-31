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
    async (args) => {
      const startTime = Date.now();
      const logger = getLogger();
      const github = getGitHubService();
      const locking = getLockingService();
      const workflow = getWorkflowService();

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

        await workflow.deleteWorkflowState(owner, repo, args.issueNumber);

        if (args.reason === 'abandoned') {
          await github.updateIssueLabel(owner, repo, args.issueNumber, ['status:backlog'], ['status:in-progress', 'status:in-review']);
        } else if (args.reason === 'completed' || args.reason === 'merged') {
          await github.updateIssueLabel(owner, repo, args.issueNumber, [], ['status:in-progress', 'status:in-review']);
          if (args.reason === 'merged') {
            await github.closeIssue(owner, repo, args.issueNumber);
          }
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
  );
}
