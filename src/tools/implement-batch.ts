import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getBatchService } from '../services/batch.js';
import { getLogger } from '../services/logging.js';
import { filterAndScoreIssues } from '../services/priority.js';

function parseRepository(repository: string): { owner: string; repo: string } | null {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function registerImplementBatchTool(server: McpServer) {
  server.tool(
    'implement_batch',
    'Start implementing a batch of N issues in priority order. Returns the first issue to implement.',
    {
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .describe("Repository in 'owner/repo' format"),
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe('Number of issues to implement'),
      includeTypes: z
        .array(z.enum(['bug', 'feature', 'chore', 'docs']))
        .optional()
        .describe('Only include these issue types'),
      excludeTypes: z
        .array(z.enum(['bug', 'feature', 'chore', 'docs']))
        .optional()
        .describe('Exclude these issue types'),
      maxPriority: z
        .enum(['P0', 'P1', 'P2', 'P3'])
        .optional()
        .describe('Only include issues at or above this priority'),
    },
    async (args) => {
      const startTime = Date.now();
      const logger = getLogger();
      const github = getGitHubService();
      const batchService = getBatchService();

      const parsed = parseRepository(args.repository);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid repository format' }) }],
          isError: true,
        };
      }

      const { owner, repo } = parsed;

      try {
        // Get prioritized issues
        const allIssues = await github.listOpenIssues(owner, repo);
        const scoredIssues = filterAndScoreIssues(allIssues, {
          includeTypes: args.includeTypes,
          excludeTypes: args.excludeTypes,
        });

        // Filter by max priority if specified
        let eligibleIssues = scoredIssues;
        if (args.maxPriority) {
          const priorityOrder = ['P0', 'P1', 'P2', 'P3'];
          const maxIndex = priorityOrder.indexOf(args.maxPriority);
          eligibleIssues = scoredIssues.filter(({ issue }) => {
            const priorityLabel = issue.labels.find((l) => l.name.startsWith('priority:'));
            if (!priorityLabel) return false;
            const priority = priorityLabel.name.replace('priority:', '').toUpperCase();
            const priorityIndex = priorityOrder.indexOf(priority);
            return priorityIndex <= maxIndex;
          });
        }

        if (eligibleIssues.length === 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ action: 'empty', reason: 'No issues match criteria' }),
            }],
          };
        }

        // Create batch with top N issues
        const issueNumbers = eligibleIssues.slice(0, args.count).map((s) => s.issue.number);
        const batch = await batchService.createBatch(args.repository, issueNumbers);

        // Start first issue
        const firstIssueNumber = await batchService.startNextIssue(batch.batchId);
        const firstIssue = eligibleIssues.find((s) => s.issue.number === firstIssueNumber);
        if (!firstIssue) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Issue not found in batch' }) }],
            isError: true,
          };
        }

        const duration = Date.now() - startTime;
        await logger.info('implement_batch', {
          repoFullName: args.repository,
          metadata: { batchId: batch.batchId, count: issueNumbers.length, duration },
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              action: 'implement',
              batchId: batch.batchId,
              progress: { current: 1, total: batch.totalCount },
              issue: {
                number: firstIssue.issue.number,
                title: firstIssue.issue.title,
                body: firstIssue.issue.body,
                html_url: firstIssue.issue.html_url,
                priority: firstIssue.score.basePoints,
              },
              instructions: `Implement issue #${firstIssue.issue.number}: ${firstIssue.issue.title}. Create a PR when ready, then call batch_continue with the PR number.`,
            }),
          }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('implement_batch', errorMessage, { repoFullName: args.repository });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: errorMessage }) }],
          isError: true,
        };
      }
    }
  );
}
