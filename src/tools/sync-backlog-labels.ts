import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getLogger } from '../services/logging.js';
import { resolveRepository } from '../utils/repository.js';

interface LabelIssue {
  number: number;
  title: string;
  url: string;
  missingPriority: boolean;
  missingType: boolean;
  missingStatus: boolean;
  currentLabels: string[];
}

export function registerSyncBacklogLabelsTool(server: McpServer) {
  server.tool(
    'sync_backlog_labels',
    'Detect and optionally fix issues missing required priority/type labels',
    {
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .describe("Repository in 'owner/repo' format"),
      mode: z
        .enum(['report', 'update'])
        .default('report')
        .describe("'report' to list issues, 'update' to apply default labels"),
      defaultPriority: z
        .enum(['P0', 'P1', 'P2', 'P3'])
        .optional()
        .describe('Default priority to apply when updating (defaults to P2)'),
      defaultType: z
        .enum(['bug', 'feature', 'chore', 'docs'])
        .optional()
        .describe('Default type to apply when updating (defaults to feature)'),
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
      const repoFullName = `${owner}/${repo}`;

      try {
        // Ensure all required labels exist in the repo
        await github.ensureLabelsExist(owner, repo);

        // Get all open issues
        const issues = await github.listOpenIssues(owner, repo);

        // Analyze each issue for missing labels
        const issuesWithProblems: LabelIssue[] = [];

        for (const issue of issues) {
          const labelNames = issue.labels.map((l) => l.name.toLowerCase());

          const hasPriority = labelNames.some((l) =>
            ['priority:p0', 'priority:p1', 'priority:p2', 'priority:p3'].includes(l)
          );
          const hasType = labelNames.some((l) =>
            ['type:bug', 'type:feature', 'type:chore', 'type:docs'].includes(l)
          );
          const hasStatus = labelNames.some((l) =>
            ['status:backlog', 'status:in-progress', 'status:in-review'].includes(l)
          );

          if (!hasPriority || !hasType || !hasStatus) {
            issuesWithProblems.push({
              number: issue.number,
              title: issue.title,
              url: issue.html_url,
              missingPriority: !hasPriority,
              missingType: !hasType,
              missingStatus: !hasStatus,
              currentLabels: issue.labels.map((l) => l.name),
            });
          }
        }

        // If update mode, apply default labels
        const updates: Array<{ issueNumber: number; labelsAdded: string[] }> = [];

        if (args.mode === 'update' && issuesWithProblems.length > 0) {
          const defaultPriority = args.defaultPriority ?? 'P2';
          const defaultType = args.defaultType ?? 'feature';

          for (const issue of issuesWithProblems) {
            const labelsToAdd: string[] = [];

            if (issue.missingPriority) {
              labelsToAdd.push(`priority:${defaultPriority}`);
            }
            if (issue.missingType) {
              labelsToAdd.push(`type:${defaultType}`);
            }
            if (issue.missingStatus) {
              labelsToAdd.push('status:backlog');
            }

            if (labelsToAdd.length > 0) {
              await github.updateIssueLabel(owner, repo, issue.number, labelsToAdd, []);
              updates.push({
                issueNumber: issue.number,
                labelsAdded: labelsToAdd,
              });
            }
          }
        }

        const duration = Date.now() - startTime;
        await logger.info('sync_backlog_labels', {
          repoFullName,
          duration,
          metadata: {
            mode: args.mode,
            totalIssues: issues.length,
            issuesWithProblems: issuesWithProblems.length,
            issuesUpdated: updates.length,
          },
        });

        const summary = {
          totalIssues: issues.length,
          issuesWithMissingLabels: issuesWithProblems.length,
          breakdown: {
            missingPriority: issuesWithProblems.filter((i) => i.missingPriority).length,
            missingType: issuesWithProblems.filter((i) => i.missingType).length,
            missingStatus: issuesWithProblems.filter((i) => i.missingStatus).length,
          },
        };

        if (args.mode === 'report') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                mode: 'report',
                summary,
                issues: issuesWithProblems.map((i) => ({
                  number: i.number,
                  title: i.title,
                  url: i.url,
                  missing: {
                    priority: i.missingPriority,
                    type: i.missingType,
                    status: i.missingStatus,
                  },
                  currentLabels: i.currentLabels,
                })),
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                mode: 'update',
                summary,
                updates,
                defaults: {
                  priority: args.defaultPriority ?? 'P2',
                  type: args.defaultType ?? 'feature',
                  status: 'backlog',
                },
              }),
            }],
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('sync_backlog_labels', errorMessage, { repoFullName });
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Error: ${errorMessage}`, code: 'INTERNAL_ERROR' }) }],
          isError: true,
        };
      }
    }
  );
}
