import { describe, it, expect, afterAll } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { LockingService } from '../../src/services/locking.js';
import {
  createLock,
  getLockFileName,
  parseLockFileName,
  isProcessAlive,
} from '../../src/models/lock.js';

describe('Lock Model', () => {
  const testSessionId = '550e8400-e29b-41d4-a716-446655440000'; // Valid UUID for testing

  describe('createLock', () => {
    it('creates a lock with all required fields', () => {
      const lock = createLock(42, 'owner/repo', testSessionId, 12345);

      expect(lock.issueNumber).toBe(42);
      expect(lock.repoFullName).toBe('owner/repo');
      expect(lock.sessionId).toBe(testSessionId);
      expect(lock.pid).toBe(12345);
      expect(lock.acquiredAt).toBeDefined();
      expect(lock.lastUpdated).toBeDefined();
    });

    it('uses current PID when not provided', () => {
      const lock = createLock(42, 'owner/repo', testSessionId);

      expect(lock.pid).toBe(process.pid);
    });
  });

  describe('getLockFileName', () => {
    it('generates correct lock file name', () => {
      expect(getLockFileName('owner', 'repo', 42)).toBe('owner_repo_42.lockdata');
    });

    it('handles special characters in owner/repo names', () => {
      expect(getLockFileName('my-org', 'my-repo', 123)).toBe('my-org_my-repo_123.lockdata');
    });
  });

  describe('parseLockFileName', () => {
    it('parses valid lock file name', () => {
      const result = parseLockFileName('owner_repo_42.lockdata');

      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
      });
    });

    it('returns null for invalid file name', () => {
      expect(parseLockFileName('invalid.txt')).toBeNull();
      expect(parseLockFileName('missing_issue.lockdata')).toBeNull();
      expect(parseLockFileName('')).toBeNull();
    });

    it('handles dashes in owner/repo names', () => {
      const result = parseLockFileName('my-org_my-repo_123.lockdata');

      expect(result).toEqual({
        owner: 'my-org',
        repo: 'my-repo',
        issueNumber: 123,
      });
    });
  });

  describe('isProcessAlive', () => {
    it('returns true for current process', async () => {
      const alive = await isProcessAlive(process.pid);
      expect(alive).toBe(true);
    });

    it('returns false for non-existent process', async () => {
      const alive = await isProcessAlive(999999999);
      expect(alive).toBe(false);
    });
  });
});

describe('LockingService', () => {
  // Track all test directories for cleanup
  const testDirs: string[] = [];

  // Create a unique test directory for each test
  const createTestEnv = async () => {
    const testId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const testDir = join(tmpdir(), `mcp-lock-test-${testId}`);
    await mkdir(testDir, { recursive: true });
    testDirs.push(testDir);
    // Use proper UUIDs since the Lock schema requires UUID format
    const sessionId = randomUUID();
    return { testDir, sessionId };
  };

  afterAll(async () => {
    // Cleanup all test directories
    for (const dir of testDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('acquireLock', () => {
    it('successfully acquires a new lock', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      const result = await lockingService.acquireLock('owner', 'repo', 1);

      expect(result.success).toBe(true);
      expect(result.lock).toBeDefined();
      expect(result.lock?.issueNumber).toBe(1);
      expect(result.lock?.sessionId).toBe(sessionId);
    });

    it('fails to acquire lock when already held by another session', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      const firstResult = await lockingService.acquireLock('owner', 'repo', 2);
      expect(firstResult.success).toBe(true);

      const otherSession = new LockingService(randomUUID(), testDir);
      const secondResult = await otherSession.acquireLock('owner', 'repo', 2);

      expect(secondResult.success).toBe(false);
      expect(secondResult.code).toBe('LOCK_HELD');
    });

    it('can acquire lock for different issues', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      const result1 = await lockingService.acquireLock('owner', 'repo', 1);
      const result2 = await lockingService.acquireLock('owner', 'repo', 2);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });
  });

  describe('releaseLock', () => {
    it('successfully releases own lock', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      await lockingService.acquireLock('owner', 'repo', 3);
      const released = await lockingService.releaseLock('owner', 'repo', 3);

      expect(released).toBe(true);
    });

    it('returns false when trying to release lock held by another session', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      await lockingService.acquireLock('owner', 'repo', 4);

      const otherSession = new LockingService(randomUUID(), testDir);
      const released = await otherSession.releaseLock('owner', 'repo', 4);

      expect(released).toBe(false);
    });

    it('returns true when lock does not exist', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      const released = await lockingService.releaseLock('owner', 'repo', 999);

      expect(released).toBe(true);
    });
  });

  describe('isIssueLocked', () => {
    it('returns true for locked issue', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      await lockingService.acquireLock('owner', 'repo', 5);
      const locked = await lockingService.isIssueLocked('owner', 'repo', 5);

      expect(locked).toBe(true);
    });

    it('returns false for unlocked issue', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      const locked = await lockingService.isIssueLocked('owner', 'repo', 999);

      expect(locked).toBe(false);
    });

    it('returns false after lock is released', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      await lockingService.acquireLock('owner', 'repo', 6);
      await lockingService.releaseLock('owner', 'repo', 6);
      const locked = await lockingService.isIssueLocked('owner', 'repo', 6);

      expect(locked).toBe(false);
    });
  });

  describe('getLockHolder', () => {
    it('returns session info for locked issue', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      await lockingService.acquireLock('owner', 'repo', 7);
      const holder = await lockingService.getLockHolder('owner', 'repo', 7);

      expect(holder).toBeDefined();
      expect(holder?.sessionId).toBe(sessionId);
      expect(holder?.isStale).toBe(false);
    });

    it('returns null for unlocked issue', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      const holder = await lockingService.getLockHolder('owner', 'repo', 999);

      expect(holder).toBeNull();
    });
  });

  describe('listLocks', () => {
    it('lists all locks', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      await lockingService.acquireLock('owner', 'repo', 10);
      await lockingService.acquireLock('owner', 'repo', 11);

      const locks = await lockingService.listLocks();

      expect(locks.length).toBe(2);
      expect(locks.map((l) => l.issueNumber)).toContain(10);
      expect(locks.map((l) => l.issueNumber)).toContain(11);
    });

    it('returns empty array when no locks', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      const locks = await lockingService.listLocks();

      expect(locks).toEqual([]);
    });
  });

  describe('getLocksForSession', () => {
    it('returns only locks for current session', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      await lockingService.acquireLock('owner', 'repo', 20);

      const locks = await lockingService.getLocksForSession();

      expect(locks.length).toBe(1);
      expect(locks[0].lock.sessionId).toBe(sessionId);
    });
  });

  describe('forceClaim', () => {
    it('can force claim an existing lock', async () => {
      const { testDir } = await createTestEnv();
      const firstSessionId = randomUUID();
      const otherSessionId = randomUUID();

      const firstSession = new LockingService(firstSessionId, testDir);
      await firstSession.acquireLock('owner', 'repo', 30);

      const otherSession = new LockingService(otherSessionId, testDir);
      const result = await otherSession.forceClaim('owner', 'repo', 30);

      expect(result.success).toBe(true);
      expect(result.previousHolder).toBeDefined();
      expect(result.previousHolder?.sessionId).toBe(firstSessionId);
      expect(result.lock?.sessionId).toBe(otherSessionId);
    });

    it('can claim when no lock exists', async () => {
      const { testDir, sessionId } = await createTestEnv();
      const lockingService = new LockingService(sessionId, testDir);

      const result = await lockingService.forceClaim('owner', 'repo', 31);

      expect(result.success).toBe(true);
      expect(result.previousHolder).toBeNull();
      expect(result.lock).toBeDefined();
    });
  });
});
