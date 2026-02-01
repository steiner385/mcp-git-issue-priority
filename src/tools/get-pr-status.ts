import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getLogger } from '../services/logging.js';

function parseRepository(repository: string): { owner: string; repo: string } | null {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function registerGetPrStatusTool(server: McpServer) {
  server.tool(
    'get_pr_status',
    'Check CI status, approval state, and merge state of a pull request',
    {
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .describe("Repository in 'owner/repo' format"),
      prNumber: z
        .number()
        .int()
        .positive()
        .describe('Pull request number to check'),
    },
    async (args) => {
      const logger = getLogger();
      const github = getGitHubService();

      const parsed = parseRepository(args.repository);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Invalid repository format' }) }],
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
