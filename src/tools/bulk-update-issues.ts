import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getLogger } from '../services/logging.js';
import { resolveRepository } from '../utils/repository.js';

export function registerBulkUpdateIssuesTool(server: McpServer) {
  server.tool(
    'bulk_update_issues',
    'Add/remove labels and close/reopen multiple issues at once',
    {
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .optional()
        .describe("Repository in 'owner/repo' format. Optional if GITHUB_REPOSITORY env var is set."),
      issues: z
        .array(z.number().int().positive())
        .min(1)
        .max(50)
        .describe('Issue numbers to update'),
      addLabels: z
        .array(z.string())
        .optional()
        .describe('Labels to add to all issues'),
      removeLabels: z
        .array(z.string())
        .optional()
        .describe('Labels to remove from all issues'),
      state: z
        .enum(['open', 'closed'])
        .optional()
        .describe('Set issue state'),
    },
    async (args) => {
      const startTime = Date.now();
      const logger = getLogger();
      const github = getGitHubService();

      const parsed = resolveRepository(args.repository);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: "Repository required. Provide 'repository' argument or set GITHUB_REPOSITORY env var.", code: 'REPO_REQUIRED' }) }],
          isError: true,
        };
      }

      const { owner, repo } = parsed;
      const updated: number[] = [];
      const failed: Array<{ issue: number; error: string }> = [];

      for (const issueNumber of args.issues) {
        try {
          // Update labels
          if (args.addLabels?.length || args.removeLabels?.length) {
            await github.updateIssueLabel(
              owner,
              repo,
              issueNumber,
              args.addLabels ?? [],
              args.removeLabels ?? []
            );
          }

          // Update state
          if (args.state) {
            await github.updateIssueState(owner, repo, issueNumber, args.state);
          }

          updated.push(issueNumber);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          failed.push({ issue: issueNumber, error: errorMessage });
        }
      }

      const duration = Date.now() - startTime;
      await logger.info('bulk_update_issues', {
        repoFullName: args.repository,
        duration,
        metadata: { total: args.issues.length, succeeded: updated.length, failed: failed.length },
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: failed.length === 0,
            updated,
            failed,
            summary: {
              total: args.issues.length,
              succeeded: updated.length,
              failed: failed.length,
            },
          }),
        }],
      };
    }
  );
}
