import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getLogger } from '../services/logging.js';
import { resolveRepository } from '../utils/repository.js';

export function registerGetPrStatusTool(server: McpServer) {
  server.tool(
    'get_pr_status',
    'Check CI status, approval state, and merge state of a pull request',
    {
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .optional()
        .describe("Repository in 'owner/repo' format. Optional if GITHUB_REPOSITORY env var is set."),
      prNumber: z
        .number()
        .int()
        .positive()
        .describe('Pull request number to check'),
    },
    async (args) => {
      const logger = getLogger();
      const github = getGitHubService();

      const parsed = resolveRepository(args.repository);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: "Repository required. Provide 'repository' argument or set GITHUB_REPOSITORY env var." }) }],
          isError: true,
        };
      }

      try {
        const status = await github.getPrStatus(parsed.owner, parsed.repo, args.prNumber);

        await logger.info('get_pr_status', {
          repoFullName: args.repository,
          metadata: { prNumber: args.prNumber, state: status.state },
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...status }) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('get_pr_status', errorMessage, { repoFullName: args.repository });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: errorMessage }) }],
          isError: true,
        };
      }
    }
  );
}
