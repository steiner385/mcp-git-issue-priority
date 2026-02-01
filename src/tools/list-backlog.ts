import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getLockingService } from '../services/locking.js';
import { getLogger } from '../services/logging.js';
import {
  scoreIssuesWithDependencies,
  comparePriorityScores,
  applyFilters,
} from '../services/priority.js';
import { getTypeLabel, getPriorityLabel } from '../models/index.js';
import { resolveRepository } from '../utils/repository.js';

export function registerListBacklogTool(server: McpServer) {
  server.tool(
    'list_backlog',
    'List issues in the backlog with priority scores (read-only, no locking)',
    {
      includeTypes: z
        .array(z.enum(['bug', 'feature', 'chore', 'docs']))
        .optional()
        .describe('Only select from these types'),
      excludeTypes: z
        .array(z.enum(['bug', 'feature', 'chore', 'docs']))
        .optional()
        .describe('Exclude these types from selection'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Maximum issues to return'),
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

      const parsed = resolveRepository(args.repository);
      if (!parsed) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: "Repository required. Provide 'repository' argument or set GITHUB_REPOSITORY env var.",
                code: 'REPO_REQUIRED',
              }),
            },
          ],
          isError: true,
        };
      }

      const { owner, repo } = parsed;
      const repoFullName = `${owner}/${repo}`;
      const limit = args.limit ?? 20;

      try {
        const allIssues = await github.listOpenIssues(owner, repo);

        // Fetch dependency info for all issues
        const dependencies = new Map<number, number | null>();
        for (const issue of allIssues) {
          const parent = await github.getIssueParent(owner, repo, issue.number);
          if (parent && parent.state === 'open') {
            dependencies.set(issue.number, parent.number);
          }
        }

        // Score with dependencies
        const filteredIssues = applyFilters(allIssues, {
          includeTypes: args.includeTypes,
          excludeTypes: args.excludeTypes,
        });
        const scoredIssues = scoreIssuesWithDependencies(filteredIssues, dependencies);
        scoredIssues.sort((a, b) => comparePriorityScores(a.score, b.score));

        const allLocks = await locking.listLocks();
        const lockedIssueNumbers = new Set(
          allLocks
            .filter((l) => l.repoFullName === repoFullName)
            .map((l) => l.issueNumber)
        );
        const lockHolders = new Map(
          allLocks
            .filter((l) => l.repoFullName === repoFullName)
            .map((l) => [l.issueNumber, l.lock.sessionId])
        );

        const backlog = scoredIssues
          .slice(0, limit)
          .map(({ issue, score, ageInDays, blockedByIssue }) => {
            const priorityLabel = getPriorityLabel(issue);
            const typeLabel = getTypeLabel(issue);
            const isLocked = lockedIssueNumbers.has(issue.number);

            return {
              number: issue.number,
              title: issue.title,
              priority: priorityLabel?.replace('priority:', '') ?? null,
              type: typeLabel?.replace('type:', '') ?? null,
              priorityScore: score.totalScore,
              ageInDays,
              isLocked,
              lockedBy: isLocked ? lockHolders.get(issue.number) ?? null : null,
              blockedBy: blockedByIssue ?? null,
            };
          });

        const duration = Date.now() - startTime;
        await logger.info('list_backlog', {
          repoFullName,
          duration,
          metadata: {
            total: scoredIssues.length,
            returned: backlog.length,
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                backlog,
                total: scoredIssues.length,
              }),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('list_backlog', errorMessage, {
          repoFullName,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: `GitHub API error: ${errorMessage}`,
                code: 'GITHUB_API_ERROR',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
