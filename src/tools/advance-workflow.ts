import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitHubService, getGitHubService } from '../services/github.js';
import { LockingService, getLockingService } from '../services/locking.js';
import { WorkflowService, getWorkflowService } from '../services/workflow.js';
import { AuditLogger, getLogger } from '../services/logging.js';
import { resolveRepository } from '../utils/repository.js';

export type WorkflowPhase =
  | 'research'
  | 'branch'
  | 'implementation'
  | 'testing'
  | 'commit'
  | 'pr'
  | 'review';

export interface AdvanceWorkflowArgs {
  issueNumber: number;
  targetPhase: WorkflowPhase;
  skipJustification?: string;
  testsPassed?: boolean;
  prTitle?: string;
  prBody?: string;
  repository?: string;
}

export interface AdvanceWorkflowDeps {
  github: GitHubService;
  locking: LockingService;
  workflow: WorkflowService;
  logger: Pick<AuditLogger, 'info' | 'warn' | 'error'>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Pure handler for `advance_workflow`. Extracted from the tool registration so
 * it can be unit-tested with injected dependencies. The PR-phase flow releases
 * the filesystem lock once the PR exists — at that point the issue is claimed
 * via the `status:in-review` GitHub label, so a session that crashes between
 * PR creation and merge does not leave the issue indefinitely locked.
 */
export async function handleAdvanceWorkflow(
  args: AdvanceWorkflowArgs,
  deps: AdvanceWorkflowDeps
): Promise<ToolResult> {
  const startTime = Date.now();
  const { github, locking, workflow, logger } = deps;

  const parsed = resolveRepository(args.repository);
  if (!parsed) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error:
              "Repository required. Provide 'repository' argument or set GITHUB_REPOSITORY env var.",
            code: 'REPO_REQUIRED',
          }),
        },
      ],
      isError: true,
    };
  }

  const { owner, repo } = parsed;
  const repoFullName = `${owner}/${repo}`;

  try {
    const lockHolder = await locking.getLockHolder(owner, repo, args.issueNumber);
    if (!lockHolder) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'Issue not locked by this session',
              code: 'NOT_LOCKED',
              reason: 'not_locked',
            }),
          },
        ],
        isError: true,
      };
    }

    const state = await workflow.getWorkflowState(owner, repo, args.issueNumber);
    if (!state) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'Workflow state not found',
              code: 'WORKFLOW_NOT_FOUND',
            }),
          },
        ],
        isError: true,
      };
    }

    const result = await workflow.recordPhaseTransition(
      owner,
      repo,
      args.issueNumber,
      args.targetPhase,
      'advance_workflow',
      { testsPassed: args.testsPassed, skipJustification: args.skipJustification }
    );

    if (!result.success) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: result.error,
              code: result.code,
              reason: result.code === 'TESTS_REQUIRED' ? 'tests_required' : 'invalid_transition',
            }),
          },
        ],
        isError: true,
      };
    }

    const updatedState = await workflow.getWorkflowState(owner, repo, args.issueNumber);
    let branchName = updatedState?.branchName;
    let prNumber = updatedState?.prNumber;
    let prUrl: string | undefined;

    if (args.targetPhase === 'branch' && !branchName) {
      const issue = await github.getIssue(owner, repo, args.issueNumber);
      branchName = workflow.generateBranchName(args.issueNumber, issue.title);
      await github.createBranch(owner, repo, branchName);
      await workflow.updateBranchName(owner, repo, args.issueNumber, branchName);
    }

    let lockReleasedOnPr = false;
    if (args.targetPhase === 'pr' && args.prTitle && args.prBody && branchName) {
      const pr = await github.createPullRequest(owner, repo, {
        title: args.prTitle,
        body: args.prBody,
        head: branchName,
      });
      prNumber = pr.number;
      prUrl = pr.html_url;
      await workflow.updatePrNumber(owner, repo, args.issueNumber, prNumber);
      await github.updateIssueLabel(
        owner,
        repo,
        args.issueNumber,
        ['status:in-review'],
        ['status:in-progress']
      );

      // Once the PR exists, the issue is signalled as claimed via
      // `status:in-review` on GitHub. Drop the local filesystem lock so a
      // session that crashes between `pr` and `merged` does not leave
      // the issue indefinitely locked. Other sessions can still see the
      // PR via the `in-review` label and the workflow state file.
      lockReleasedOnPr = await locking.releaseLock(owner, repo, args.issueNumber);
    }

    const duration = Date.now() - startTime;
    await logger.info('advance_workflow', {
      repoFullName,
      issueNumber: args.issueNumber,
      phase: args.targetPhase,
      duration,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            workflow: {
              previousPhase: result.previousPhase,
              currentPhase: result.currentPhase,
              ...(branchName && { branchName }),
              ...(prNumber && { prNumber }),
              ...(prUrl && { prUrl }),
              ...(lockReleasedOnPr && { lockReleased: true }),
            },
          }),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await logger.error('advance_workflow', errorMessage, {
      repoFullName,
      issueNumber: args.issueNumber,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Error: ${errorMessage}`,
            code: 'INTERNAL_ERROR',
          }),
        },
      ],
      isError: true,
    };
  }
}

export function registerAdvanceWorkflowTool(server: McpServer) {
  server.tool(
    'advance_workflow',
    'Advance the workflow to the next phase for the currently locked issue',
    {
      issueNumber: z.number().int().positive().describe('Issue number to advance'),
      targetPhase: z
        .enum(['research', 'branch', 'implementation', 'testing', 'commit', 'pr', 'review'])
        .describe('Target workflow phase'),
      skipJustification: z.string().optional().describe('Required if skipping phases'),
      testsPassed: z.boolean().optional().describe("Required when advancing to 'commit' phase"),
      prTitle: z.string().optional().describe("PR title (required for 'pr' phase)"),
      prBody: z.string().optional().describe("PR body (required for 'pr' phase)"),
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .optional()
        .describe("Repository in 'owner/repo' format"),
    },
    async (args) =>
      handleAdvanceWorkflow(args, {
        github: getGitHubService(),
        locking: getLockingService(),
        workflow: getWorkflowService(),
        logger: getLogger(),
      })
  );
}
