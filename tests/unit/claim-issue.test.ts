import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { LockingService } from '../../src/services/locking.js';
import { WorkflowService } from '../../src/services/workflow.js';
import { handleClaimIssue, type ClaimIssueDeps } from '../../src/tools/claim-issue.js';
import { getLockFileName } from '../../src/models/lock.js';
import { resetConfig } from '../../src/config/index.js';

describe('claim_issue handler', () => {
  const testDirs: string[] = [];

  const createEnv = async () => {
    const baseDir = join(tmpdir(), `claim-issue-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const locksDir = join(baseDir, 'locks');
    const workflowDir = join(baseDir, 'workflow');
    await mkdir(locksDir, { recursive: true });
    await mkdir(workflowDir, { recursive: true });
    testDirs.push(baseDir);
    const sessionId = randomUUID();
    const locking = new LockingService(sessionId, locksDir);
    const workflow = new WorkflowService(sessionId, workflowDir);
    const logger = {
      info: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    };
    const deps: ClaimIssueDeps = { locking, workflow, logger };
    return { baseDir, locksDir, workflowDir, sessionId, locking, workflow, logger, deps };
  };

  afterAll(async () => {
    for (const dir of testDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // resolveRepository reads GITHUB_REPOSITORY through getConfig(), which caches
  // the value as a module-level singleton on first read. Reset the cache and
  // re-set the env vars per-test so mutations within a test don't leak.
  // GITHUB_TOKEN is required for createConfig() to succeed in CI (no `gh` CLI).
  beforeEach(() => {
    process.env.GITHUB_REPOSITORY = 'tester/sample';
    process.env.GITHUB_TOKEN = 'test-token';
    resetConfig();
  });

  describe('repo resolution', () => {
    it('returns REPO_REQUIRED when neither argument nor env var is set', async () => {
      const { deps } = await createEnv();
      delete process.env.GITHUB_REPOSITORY;

      const result = await handleClaimIssue({ issueNumber: 1 }, deps);

      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(false);
      expect(body.code).toBe('REPO_REQUIRED');
    });

    it('uses the explicit repository argument over the env var', async () => {
      const { deps, locking } = await createEnv();
      process.env.GITHUB_REPOSITORY = 'env/wrong';

      await handleClaimIssue({ issueNumber: 5, repository: 'arg/right' }, deps);

      const locks = await locking.listLocks();
      expect(locks).toHaveLength(1);
      expect(locks[0].lock.repoFullName).toBe('arg/right');
    });
  });

  describe('happy path', () => {
    it('acquires the lock and returns the lock metadata', async () => {
      const { deps, sessionId } = await createEnv();

      const result = await handleClaimIssue({ issueNumber: 42 }, deps);

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(true);
      expect(body.issueNumber).toBe(42);
      expect(body.lock.sessionId).toBe(sessionId);
      expect(body.lock.acquiredAt).toBeDefined();
      expect(body.staleSwept).toBe(0);
    });

    it('reports the count of stale locks swept before acquisition', async () => {
      const { deps, locking, locksDir } = await createEnv();

      // Plant a stale lock (9-hour-old timestamp, exceeds the 8-hour timeout) for an unrelated issue
      const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
      const stale = {
        issueNumber: 998,
        repoFullName: 'tester/sample',
        pid: process.pid,
        sessionId: randomUUID(),
        acquiredAt: nineHoursAgo,
        lastUpdated: nineHoursAgo,
      };
      await writeFile(
        join(locksDir, getLockFileName('tester', 'sample', 998)),
        JSON.stringify(stale, null, 2)
      );

      const result = await handleClaimIssue({ issueNumber: 100 }, deps);

      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(true);
      expect(body.staleSwept).toBe(1);

      // Stale lock was reaped; only the new one remains
      const remaining = await locking.listLocks();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].issueNumber).toBe(100);
    });

    it('logs an info entry with duration and stale-sweep count', async () => {
      const { deps, logger } = await createEnv();

      await handleClaimIssue({ issueNumber: 7 }, deps);

      expect(logger.info).toHaveBeenCalledTimes(1);
      const [event, payload] = logger.info.mock.calls[0];
      expect(event).toBe('claim_issue');
      expect(payload).toMatchObject({
        repoFullName: 'tester/sample',
        issueNumber: 7,
        metadata: { staleSwept: 0 },
      });
      expect(typeof payload.duration).toBe('number');
    });
  });

  describe('workflow state', () => {
    it('creates a research-phase state file on successful claim', async () => {
      const { deps, workflow } = await createEnv();

      await handleClaimIssue({ issueNumber: 42 }, deps);

      const state = await workflow.getWorkflowState('tester', 'sample', 42);
      expect(state).not.toBeNull();
      expect(state!.currentPhase).toBe('selection');
    });

    it('preserves an existing state file (does not overwrite in-flight phase)', async () => {
      const { deps, workflow } = await createEnv();

      // Pre-create a state at pr phase (e.g., from a prior session's advance_workflow)
      await workflow.createWorkflowState('tester', 'sample', 55, 'prior-session');
      await workflow.recordPhaseTransition('tester', 'sample', 55, 'pr', 'test', {
        skipJustification: 'test',
      });

      await handleClaimIssue({ issueNumber: 55 }, deps);

      const state = await workflow.getWorkflowState('tester', 'sample', 55);
      expect(state).not.toBeNull();
      expect(state!.currentPhase).toBe('pr'); // unchanged
    });
  });

  describe('LOCK_HELD path', () => {
    it('reports the current holder when the lock is taken by another session', async () => {
      const { locksDir, deps } = await createEnv();

      // Another session pre-acquires the lock
      const otherSessionId = randomUUID();
      const otherLocking = new LockingService(otherSessionId, locksDir);
      await otherLocking.acquireLock('tester', 'sample', 99);

      const result = await handleClaimIssue({ issueNumber: 99 }, deps);

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(false);
      expect(body.code).toBe('LOCK_HELD');
      expect(body.issueNumber).toBe(99);
      expect(body.holder).toEqual({
        sessionId: otherSessionId,
        isStale: false,
      });
    });

    it('logs a warn entry on LOCK_HELD with the holder session id', async () => {
      const { locksDir, deps, logger } = await createEnv();
      const otherSessionId = randomUUID();
      const otherLocking = new LockingService(otherSessionId, locksDir);
      await otherLocking.acquireLock('tester', 'sample', 50);

      await handleClaimIssue({ issueNumber: 50 }, deps);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [event, message, payload] = logger.warn.mock.calls[0];
      expect(event).toBe('claim_issue');
      expect(message).toBe('Issue already locked');
      expect(payload.metadata.holderSessionId).toBe(otherSessionId);
      expect(payload.metadata.isStale).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns LOCK_SERVICE_ERROR and logs when the service throws', async () => {
      const { deps, locking, logger } = await createEnv();
      // Force the service to throw — sweepStaleLocks is the first call.
      vi.spyOn(locking, 'sweepStaleLocks').mockRejectedValueOnce(new Error('disk full'));

      const result = await handleClaimIssue({ issueNumber: 1 }, deps);

      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(false);
      expect(body.code).toBe('LOCK_SERVICE_ERROR');
      expect(body.error).toContain('disk full');

      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });
});
