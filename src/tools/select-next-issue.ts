import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getLockingService } from '../services/locking.js';
import { getWorkflowService } from '../services/workflow.js';
import { getLogger } from '../services/logging.js';
import {
  scoreIssuesWithDependencies,
  comparePriorityScores,
  applyFilters,
} from '../services/priority.js';
import { getTypeLabel, getPriorityLabel } from '../models/index.js';

function parseRepository(repository?: string): { owner: string; repo: string } | null {
  if (!repository) return null;
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function registerSelectNextIssueTool(server: McpServer) {
  server.tool(
    'select_next_issue',
    'Select and lock the highest-priority issue from the backlog',
    {
      includeTypes: z
        .array(z.enum(['bug', 'feature', 'chore', 'docs']))
        .optional()
        .describe('Only select from these types'),
      excludeTypes: z
        .array(z.enum(['bug', 'feature', 'chore', 'docs']))
        .optional()
        .describe('Exclude these types from selection'),
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
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Repository is required',
                code: 'REPO_REQUIRED',
                reason: 'no_issues',
              }),
            },
          ],
          isError: true,
        };
      }

      const { owner, repo } = parsed;
      const repoFullName = `${owner}/${repo}`;

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

        if (scoredIssues.length === 0) {
          await logger.warn('select_next_issue', 'No issues match criteria', {
            repoFullName,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'No issues match criteria',
                  code: 'NO_ISSUES_AVAILABLE',
                  reason: 'no_issues',
                }),
              },
            ],
          };
        }

        let selectedIssue = null;
        let lockResult = null;

        for (const { issue, score, ageInDays } of scoredIssues) {
          const result = await locking.acquireLock(owner, repo, issue.number);

          if (result.success) {
            selectedIssue = { issue, score, ageInDays };
            lockResult = result;
            break;
          }
        }

        if (!selectedIssue || !lockResult) {
          await logger.warn('select_next_issue', 'All matching issues are locked', {
            repoFullName,
            metadata: {
              totalIssues: allIssues.length,
              matchingFilter: scoredIssues.length,
            },
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'All matching issues are currently locked',
                  code: 'ALL_ISSUES_LOCKED',
                  reason: 'all_locked',
                  details: {
                    totalIssues: allIssues.length,
                    matchingFilter: scoredIssues.length,
                    locked: scoredIssues.length,
                  },
                }),
              },
            ],
          };
        }

        await github.updateIssueLabel(
          owner,
          repo,
          selectedIssue.issue.number,
          ['status:in-progress'],
          ['status:backlog']
        );

        const workflowState = await workflow.createWorkflowState(
          owner,
          repo,
          selectedIssue.issue.number,
          'select_next_issue'
        );

        const duration = Date.now() - startTime;
        await logger.info('select_next_issue', {
          repoFullName,
          issueNumber: selectedIssue.issue.number,
          phase: 'selection',
          duration,
          metadata: {
            priorityScore: selectedIssue.score.totalScore,
            ageInDays: selectedIssue.ageInDays,
          },
        });

        const priorityLabel = getPriorityLabel(selectedIssue.issue);
        const typeLabel = getTypeLabel(selectedIssue.issue);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                issue: {
                  number: selectedIssue.issue.number,
                  title: selectedIssue.issue.title,
                  html_url: selectedIssue.issue.html_url,
                  priority: priorityLabel?.replace('priority:', '') ?? null,
                  type: typeLabel?.replace('type:', '') ?? null,
                  priorityScore: selectedIssue.score.totalScore,
                  ageInDays: selectedIssue.ageInDays,
                },
                lock: {
                  sessionId: lockResult.lock!.sessionId,
                  acquiredAt: lockResult.lock!.acquiredAt,
                },
                workflow: {
                  currentPhase: workflowState.currentPhase,
                },
              }),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('select_next_issue', errorMessage, {
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
                reason: 'api_error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
