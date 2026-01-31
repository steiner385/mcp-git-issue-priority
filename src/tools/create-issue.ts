import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGitHubService } from '../services/github.js';
import { getLogger } from '../services/logging.js';
import { IssuePrioritySchema, IssueTypeSchema } from '../models/index.js';

export const CreateIssueInputSchema = z.object({
  title: z.string().min(1).max(256).describe('Issue title'),
  priority: IssuePrioritySchema.describe('Priority level'),
  type: IssueTypeSchema.describe('Issue type'),
  body: z.string().optional().describe('Issue body in markdown'),
  context: z.string().optional().describe('Context/background for the issue'),
  acceptanceCriteria: z.array(z.string()).optional().describe('List of acceptance criteria'),
  technicalNotes: z.string().optional().describe('Implementation hints'),
  repository: z
    .string()
    .regex(/^[^/]+\/[^/]+$/)
    .optional()
    .describe("Repository in 'owner/repo' format"),
});

export type CreateIssueInput = z.infer<typeof CreateIssueInputSchema>;

export interface FormatIssueBodyOptions {
  title: string;
  body?: string;
  context?: string;
  acceptanceCriteria?: string[];
  technicalNotes?: string;
}

export function formatIssueBody(options: FormatIssueBodyOptions): string {
  if (options.body) {
    return options.body;
  }

  const sections: string[] = [];

  sections.push('## Summary');
  sections.push(options.title);

  if (options.context) {
    sections.push('');
    sections.push('## Context');
    sections.push(options.context);
  }

  if (options.acceptanceCriteria && options.acceptanceCriteria.length > 0) {
    sections.push('');
    sections.push('## Acceptance Criteria');
    for (const criterion of options.acceptanceCriteria) {
      sections.push(`- [ ] ${criterion}`);
    }
  }

  if (options.technicalNotes) {
    sections.push('');
    sections.push('## Technical Notes');
    sections.push(options.technicalNotes);
  }

  return sections.join('\n');
}

function parseRepository(repository?: string): { owner: string; repo: string } | null {
  if (!repository) return null;
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function registerCreateIssueTool(server: McpServer) {
  server.tool(
    'create_issue',
    'Create a new GitHub issue with mandatory priority and type labels',
    {
      title: z.string().min(1).max(256).describe('Issue title'),
      priority: z.enum(['critical', 'high', 'medium', 'low']).describe('Priority level'),
      type: z.enum(['bug', 'feature', 'chore', 'docs']).describe('Issue type'),
      body: z.string().optional().describe('Issue body in markdown'),
      context: z.string().optional().describe('Context/background for the issue'),
      acceptanceCriteria: z.array(z.string()).optional().describe('List of acceptance criteria'),
      technicalNotes: z.string().optional().describe('Implementation hints'),
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

      const parsed = parseRepository(args.repository);
      if (!parsed && !args.repository) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Repository is required',
                code: 'REPO_REQUIRED',
              }),
            },
          ],
          isError: true,
        };
      }

      if (!parsed) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Invalid repository format. Use owner/repo',
                code: 'INVALID_REPO_FORMAT',
              }),
            },
          ],
          isError: true,
        };
      }

      const { owner, repo } = parsed;

      try {
        const hasAccess = await github.verifyRepoAccess(owner, repo);
        if (!hasAccess) {
          await logger.error('create_issue', 'No write access to repository', {
            repoFullName: `${owner}/${repo}`,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'No write access to repository',
                  code: 'NO_WRITE_ACCESS',
                }),
              },
            ],
            isError: true,
          };
        }

        const body = formatIssueBody({
          title: args.title,
          body: args.body,
          context: args.context,
          acceptanceCriteria: args.acceptanceCriteria,
          technicalNotes: args.technicalNotes,
        });

        const issue = await github.createIssue({
          owner,
          repo,
          title: args.title,
          body,
          priority: args.priority,
          type: args.type,
        });

        const duration = Date.now() - startTime;
        await logger.info('create_issue', {
          repoFullName: `${owner}/${repo}`,
          issueNumber: issue.number,
          duration,
          metadata: {
            priority: args.priority,
            type: args.type,
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                issue: {
                  number: issue.number,
                  title: issue.title,
                  html_url: issue.html_url,
                  labels: issue.labels.map((l) => l.name),
                },
              }),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('create_issue', errorMessage, {
          repoFullName: `${owner}/${repo}`,
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
