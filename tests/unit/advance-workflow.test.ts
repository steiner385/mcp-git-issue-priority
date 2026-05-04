import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { LockingService } from '../../src/services/locking.js';
import {
  handleAdvanceWorkflow,
  type AdvanceWorkflowDeps,
} from '../../src/tools/advance-workflow.js';
import { resetConfig } from '../../src/config/index.js';

describe('advance_workflow handler', () => {
  const testDirs: string[] = [];

  const createEnv = async () => {
    const baseDir = join(tmpdir(), `advance-workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const locksDir = join(baseDir, 'locks');
    const workflowDir = join(baseDir, 'workflow');
    await mkdir(locksDir, { recursive: true });
    await mkdir(workflowDir, { recursive: true });
    testDirs.push(baseDir);

    const sessionId = randomUUID();
    const locking = new LockingService(sessionId, locksDir);

    // GitHub and workflow services are stubbed — we don't want this test
    // hitting the network or touching the per-process workflow singleton.
    const github = {
      getIssue: vi.fn().mockResolvedValue({ title: 'Sample issue' }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockResolvedValue({
        number: 4242,
        html_url: 'https://github.com/tester/sample/pull/4242',
      }),
      updateIssueLabel: vi.fn().mockResolvedValue(undefined),
    };

    const workflow = {
      getWorkflowState: vi.fn(),
      recordPhaseTransition: vi.fn(),
      generateBranchName: vi.fn().mockReturnValue('fix/123-sample-issue'),
      updateBranchName: vi.fn().mockResolvedValue(undefined),
      updatePrNumber: vi.fn().mockResolvedValue(undefined),
    };

    const logger = {
      info: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    };

    const deps = {
      github: github as unknown,
      locking,
      workflow: workflow as unknown,
      logger,
    } as AdvanceWorkflowDeps;

    return { sessionId, locking, github, workflow, logger, deps };
  };

  afterAll(async () => {
    for (const dir of testDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // GITHUB_TOKEN is required for createConfig() to succeed when getConfig()
  // lazily constructs a config in CI (no `gh` CLI to fall back on).
  beforeEach(() => {
    process.env.GITHUB_REPOSITORY = 'tester/sample';
    process.env.GITHUB_TOKEN = 'test-token';
    resetConfig();
  });

  describe('PR phase — lock release', () => {
    it('releases the filesystem lock after creating the PR', async () => {
      const { deps, locking, workflow } = await createEnv();

      // The session holds the lock
      await locking.acquireLock('tester', 'sample', 100);
      expect(await locking.getLockHolder('tester', 'sample', 100)).not.toBeNull();

      // Workflow state pretends we already created the branch
      (workflow.getWorkflowState as ReturnType<typeof vi.fn>).mockResolvedValue({
        issueNumber: 100,
        branchName: 'fix/100-sample-issue',
        currentPhase: 'commit',
      });
      (workflow.recordPhaseTransition as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        previousPhase: 'commit',
        currentPhase: 'pr',
      });

      const result = await handleAdvanceWorkflow(
        {
          issueNumber: 100,
          targetPhase: 'pr',
          prTitle: 'fix: handle bug',
          prBody: 'Closes #100',
        },
        deps
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(true);
      expect(body.workflow.lockReleased).toBe(true);
      expect(body.workflow.prNumber).toBe(4242);

      // Lock is gone — another session could now acquire it
      expect(await locking.getLockHolder('tester', 'sample', 100)).toBeNull();
    });

    it('does not release the lock when PR creation is skipped (missing prTitle)', async () => {
      const { deps, locking, workflow } = await createEnv();

      await locking.acquireLock('tester', 'sample', 101);

      (workflow.getWorkflowState as ReturnType<typeof vi.fn>).mockResolvedValue({
        issueNumber: 101,
        branchName: 'fix/101-sample',
        currentPhase: 'commit',
      });
      (workflow.recordPhaseTransition as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        previousPhase: 'commit',
        currentPhase: 'pr',
      });

      const result = await handleAdvanceWorkflow(
        {
          issueNumber: 101,
          targetPhase: 'pr',
          // prTitle and prBody intentionally omitted
        },
        deps
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(true);
      // No PR was created, no lock released
      expect(body.workflow.lockReleased).toBeUndefined();
      expect(body.workflow.prNumber).toBeUndefined();
      expect(await locking.getLockHolder('tester', 'sample', 101)).not.toBeNull();
    });

    it('does not release the lock on non-pr phases', async () => {
      const { deps, locking, workflow } = await createEnv();

      await locking.acquireLock('tester', 'sample', 102);

      (workflow.getWorkflowState as ReturnType<typeof vi.fn>).mockResolvedValue({
        issueNumber: 102,
        currentPhase: 'research',
      });
      (workflow.recordPhaseTransition as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        previousPhase: 'research',
        currentPhase: 'implementation',
      });

      const result = await handleAdvanceWorkflow(
        { issueNumber: 102, targetPhase: 'implementation' },
        deps
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(true);
      expect(body.workflow.lockReleased).toBeUndefined();
      expect(await locking.getLockHolder('tester', 'sample', 102)).not.toBeNull();
    });
  });

  describe('error paths', () => {
    it('returns NOT_LOCKED when the session does not hold the lock', async () => {
      const { deps } = await createEnv();
      // No acquireLock — this session is not the holder

      const result = await handleAdvanceWorkflow(
        { issueNumber: 200, targetPhase: 'implementation' },
        deps
      );

      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(false);
      expect(body.code).toBe('NOT_LOCKED');
    });

    it('returns WORKFLOW_NOT_FOUND when no workflow state exists', async () => {
      const { deps, locking, workflow } = await createEnv();

      await locking.acquireLock('tester', 'sample', 201);
      (workflow.getWorkflowState as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await handleAdvanceWorkflow(
        { issueNumber: 201, targetPhase: 'implementation' },
        deps
      );

      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('surfaces TESTS_REQUIRED reason from invalid transitions', async () => {
      const { deps, locking, workflow } = await createEnv();

      await locking.acquireLock('tester', 'sample', 202);
      (workflow.getWorkflowState as ReturnType<typeof vi.fn>).mockResolvedValue({
        issueNumber: 202,
        currentPhase: 'testing',
      });
      (workflow.recordPhaseTransition as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'Tests must pass before commit',
        code: 'TESTS_REQUIRED',
      });

      const result = await handleAdvanceWorkflow(
        { issueNumber: 202, targetPhase: 'commit' },
        deps
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe('TESTS_REQUIRED');
      expect(body.reason).toBe('tests_required');
    });
  });
});
