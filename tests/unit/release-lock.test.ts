import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { LockingService } from '../../src/services/locking.js';
import { WorkflowService } from '../../src/services/workflow.js';
import { handleReleaseLock, type ReleaseLockDeps } from '../../src/tools/release-lock.js';
import { resetConfig } from '../../src/config/index.js';

describe('release_lock handler', () => {
  const testDirs: string[] = [];

  const createEnv = async () => {
    const baseDir = join(tmpdir(), `release-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const locksDir = join(baseDir, 'locks');
    const workflowDir = join(baseDir, 'workflow');
    await mkdir(locksDir, { recursive: true });
    await mkdir(workflowDir, { recursive: true });
    testDirs.push(baseDir);

    const sessionId = randomUUID();
    const locking = new LockingService(sessionId, locksDir);
    const workflow = new WorkflowService(sessionId, workflowDir);

    const github = {
      updateIssueLabel: vi.fn().mockResolvedValue(undefined),
      closeIssue: vi.fn().mockResolvedValue(undefined),
    };
    const logger = {
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    };

    const deps: ReleaseLockDeps = { github, locking, workflow, logger };
    return { baseDir, locksDir, workflowDir, sessionId, locking, workflow, github, logger, deps };
  };

  afterAll(async () => {
    for (const dir of testDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  beforeEach(() => {
    process.env.GITHUB_REPOSITORY = 'tester/sample';
    process.env.GITHUB_TOKEN = 'test-token';
    resetConfig();
  });

  describe('reason: completed — PR open, awaiting merge', () => {
    it('preserves workflow state so the issue cannot be re-selected', async () => {
      const { deps, locking, workflow } = await createEnv();

      await locking.acquireLock('tester', 'sample', 10);
      await workflow.createWorkflowState('tester', 'sample', 10, 'test');
      // Advance to pr phase to simulate a PR being open
      await workflow.recordPhaseTransition('tester', 'sample', 10, 'pr', 'test', {
        skipJustification: 'test skip',
      });

      const result = await handleReleaseLock(
        { issueNumber: 10, reason: 'completed' },
        deps
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(true);

      // Lock is gone
      expect(await locking.getLockHolder('tester', 'sample', 10)).toBeNull();

      // Workflow state still exists with the pr phase intact
      const state = await workflow.getWorkflowState('tester', 'sample', 10);
      expect(state).not.toBeNull();
      expect(state!.currentPhase).toBe('pr');
    });

    it('transitions label from in-progress to in-review', async () => {
      const { deps, locking, github } = await createEnv();

      await locking.acquireLock('tester', 'sample', 11);

      await handleReleaseLock({ issueNumber: 11, reason: 'completed' }, deps);

      expect(github.updateIssueLabel).toHaveBeenCalledWith(
        'tester', 'sample', 11,
        ['status:in-review'],
        ['status:in-progress']
      );
      expect(github.closeIssue).not.toHaveBeenCalled();
    });
  });

  describe('reason: abandoned — work undone', () => {
    it('deletes workflow state so the issue re-enters the backlog', async () => {
      const { deps, locking, workflow } = await createEnv();

      await locking.acquireLock('tester', 'sample', 20);
      await workflow.createWorkflowState('tester', 'sample', 20, 'test');

      await handleReleaseLock({ issueNumber: 20, reason: 'abandoned' }, deps);

      expect(await locking.getLockHolder('tester', 'sample', 20)).toBeNull();
      expect(await workflow.getWorkflowState('tester', 'sample', 20)).toBeNull();
    });

    it('restores status:backlog label', async () => {
      const { deps, locking, github } = await createEnv();

      await locking.acquireLock('tester', 'sample', 21);

      await handleReleaseLock({ issueNumber: 21, reason: 'abandoned' }, deps);

      expect(github.updateIssueLabel).toHaveBeenCalledWith(
        'tester', 'sample', 21,
        ['status:backlog'],
        ['status:in-progress', 'status:in-review']
      );
    });
  });

  describe('reason: merged — issue closed', () => {
    it('deletes workflow state and closes the issue', async () => {
      const { deps, locking, workflow, github } = await createEnv();

      await locking.acquireLock('tester', 'sample', 30);
      await workflow.createWorkflowState('tester', 'sample', 30, 'test');

      await handleReleaseLock({ issueNumber: 30, reason: 'merged' }, deps);

      expect(await locking.getLockHolder('tester', 'sample', 30)).toBeNull();
      expect(await workflow.getWorkflowState('tester', 'sample', 30)).toBeNull();
      expect(github.closeIssue).toHaveBeenCalledWith('tester', 'sample', 30);
    });
  });

  describe('error paths', () => {
    it('returns NOT_LOCKED when no lock exists', async () => {
      const { deps } = await createEnv();

      const result = await handleReleaseLock(
        { issueNumber: 99, reason: 'completed' },
        deps
      );

      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe('NOT_LOCKED');
    });

    it('returns REPO_REQUIRED when no repository is resolvable', async () => {
      const { deps } = await createEnv();
      delete process.env.GITHUB_REPOSITORY;
      resetConfig();

      const result = await handleReleaseLock(
        { issueNumber: 1, reason: 'completed' },
        deps
      );

      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe('REPO_REQUIRED');
    });
  });
});
