import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getBatchService } from '../services/batch.js';
import { getLogger } from '../services/logging.js';

function parseRepository(repository: string): { owner: string; repo: string } | null {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const MAX_POLL_DURATION_MS = 30 * 60_000; // 30 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerBatchContinueTool(server: McpServer) {
  server.tool(
    'batch_continue',
    'Continue batch implementation. Polls for PR merge, then returns next issue or completion.',
    {
      batchId: z.string().uuid().describe('Batch ID from implement_batch'),
      prNumber: z.number().int().positive().optional().describe('PR number for the current issue'),
    },
    async (args) => {
      const logger = getLogger();
      const github = getGitHubService();
      const batchService = getBatchService();

      const batch = await batchService.getBatch(args.batchId);
      if (!batch) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Batch not found' }) }],
          isError: true,
        };
      }

      const parsed = parseRepository(batch.repository);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid repository' }) }],
          isError: true,
        };
      }

      const { owner, repo } = parsed;

      // Set PR number if provided
      if (args.prNumber) {
        await batchService.setPrNumber(args.batchId, args.prNumber);
      }

      const currentBatch = await batchService.getBatch(args.batchId);
      if (!currentBatch?.currentPr) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No PR number set. Provide prNumber argument.' }) }],
          isError: true,
        };
      }

      // Poll for PR merge
      const startTime = Date.now();
      while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
        try {
          const status = await github.getPrStatus(owner, repo, currentBatch.currentPr);

          if (status.state === 'merged') {
            // PR merged - complete current issue and get next
            await batchService.completeCurrentIssue(args.batchId);

            const updatedBatch = await batchService.getBatch(args.batchId);

            if (updatedBatch?.status === 'completed' || updatedBatch?.queue.length === 0) {
              await logger.info('batch_continue', {
                repoFullName: batch.repository,
                metadata: { batchId: args.batchId, action: 'complete' },
              });

              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    action: 'complete',
                    summary: {
                      total: updatedBatch.totalCount,
                      completed: updatedBatch.completedCount,
                      issues: updatedBatch.completed,
                    },
                  }),
                }],
              };
            }

            // Get next issue
            const nextIssueNumber = await batchService.startNextIssue(args.batchId);
            if (!nextIssueNumber) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ action: 'complete', summary: { total: updatedBatch?.totalCount } }) }],
              };
            }

            const allIssues = await github.listOpenIssues(owner, repo);
            const nextIssue = allIssues.find((i) => i.number === nextIssueNumber);

            await logger.info('batch_continue', {
              repoFullName: batch.repository,
              metadata: { batchId: args.batchId, nextIssue: nextIssueNumber },
            });

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  action: 'implement',
                  batchId: args.batchId,
                  progress: { current: (updatedBatch?.completedCount ?? 0) + 1, total: updatedBatch?.totalCount },
                  issue: nextIssue ? {
                    number: nextIssue.number,
                    title: nextIssue.title,
                    body: nextIssue.body,
                    html_url: nextIssue.html_url,
                  } : { number: nextIssueNumber },
                  instructions: `Implement issue #${nextIssueNumber}. Create a PR when ready, then call batch_continue with the PR number.`,
                }),
              }],
            };
          }

          // PR not merged yet - continue polling
          // isPrReadyToMerge can be used to provide status feedback if needed

        } catch (error) {
          // Log error but continue polling
          await logger.error('batch_continue', `Poll error: ${error}`, { repoFullName: batch.repository });
        }

        await sleep(POLL_INTERVAL_MS);
      }

      // Timeout
      await batchService.timeoutBatch(args.batchId);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            action: 'timeout',
            issue: currentBatch.currentIssue,
            prNumber: currentBatch.currentPr,
            message: 'Timed out waiting for PR to merge. Call batch_continue to resume polling.',
          }),
        }],
      };
    }
  );
}
