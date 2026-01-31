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

export function registerGetWorkflowStatusTool(server: McpServer) {
  server.tool(
    'get_workflow_status',
    'Get the current workflow status for a locked issue',
    {
      issueNumber: z.number().int().positive().optional().describe('Specific issue number'),
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .optional()
        .describe("Repository in 'owner/repo' format"),
    },
    async (args) => {
      const logger = getLogger();
      const github = getGitHubService();
      const locking = getLockingService();
      const workflow = getWorkflowService();

      const parsed = parseRepository(args.repository);
      if (!parsed && args.issueNumber) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Repository is required when specifying issue number', code: 'REPO_REQUIRED' }) }],
          isError: true,
        };
      }

      try {
        const workflows: Array<{
          issueNumber: number;
          title: string;
          currentPhase: string;
          branchName: string | null;
          testsPassed: boolean | null;
          prNumber: number | null;
          lockAcquiredAt: string;
          lockDuration: number;
          phaseHistory: Array<{ from: string; to: string; timestamp: string }>;
        }> = [];

        if (args.issueNumber && parsed) {
          const { owner, repo } = parsed;
          const state = await workflow.getWorkflowState(owner, repo, args.issueNumber);
          const lockData = await locking.readLockFile(owner, repo, args.issueNumber);

          if (state && lockData) {
            const issue = await github.getIssue(owner, repo, args.issueNumber);
            const lockDuration = Math.floor((Date.now() - new Date(lockData.acquiredAt).getTime()) / 1000);

            workflows.push({
              issueNumber: state.issueNumber,
              title: issue.title,
              currentPhase: state.currentPhase,
              branchName: state.branchName,
              testsPassed: state.testsPassed,
              prNumber: state.prNumber,
              lockAcquiredAt: lockData.acquiredAt,
              lockDuration,
              phaseHistory: state.phaseHistory.map((p) => ({
                from: p.from,
                to: p.to,
                timestamp: p.timestamp,
              })),
            });
          }
        } else {
          const locks = await locking.getLocksForSession();
          for (const lockInfo of locks) {
            const [owner, repo] = lockInfo.repoFullName.split('/');
            const state = await workflow.getWorkflowState(owner, repo, lockInfo.issueNumber);
            if (state) {
              const issue = await github.getIssue(owner, repo, lockInfo.issueNumber);
              const lockDuration = Math.floor((Date.now() - new Date(lockInfo.lock.acquiredAt).getTime()) / 1000);

              workflows.push({
                issueNumber: state.issueNumber,
                title: issue.title,
                currentPhase: state.currentPhase,
                branchName: state.branchName,
                testsPassed: state.testsPassed,
                prNumber: state.prNumber,
                lockAcquiredAt: lockInfo.lock.acquiredAt,
                lockDuration,
                phaseHistory: state.phaseHistory.map((p) => ({
                  from: p.from,
                  to: p.to,
                  timestamp: p.timestamp,
                })),
              });
            }
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: true, workflows }),
          }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('get_workflow_status', errorMessage);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Error: ${errorMessage}`, code: 'INTERNAL_ERROR' }) }],
          isError: true,
        };
      }
    }
  );
}
