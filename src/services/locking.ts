import { readFile, writeFile, unlink, readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { getLocksDir, getConfig } from '../config/index.js';
import {
  type Lock,
  createLock,
  getLockFileName,
  parseLockFileName,
  validateLock,
  isProcessAlive,
  LOCK_STALE_TIMEOUT_MS,
} from '../models/index.js';

export interface LockAcquisitionResult {
  success: boolean;
  lock?: Lock;
  error?: string;
  code?: string;
}

export interface LockInfo {
  issueNumber: number;
  repoFullName: string;
  lock: Lock;
  isStale: boolean;
}

export class LockingService {
  private locksDir: string;
  private sessionId: string;

  constructor(sessionId: string, locksDir?: string) {
    this.sessionId = sessionId;
    this.locksDir = locksDir ?? getLocksDir();
  }

  private getLockFilePath(owner: string, repo: string, issueNumber: number): string {
    return join(this.locksDir, getLockFileName(owner, repo, issueNumber));
  }

  private async ensureLocksDir(): Promise<void> {
    await mkdir(this.locksDir, { recursive: true });
  }

  async acquireLock(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<LockAcquisitionResult> {
    await this.ensureLocksDir();
    const lockFilePath = this.getLockFilePath(owner, repo, issueNumber);

    const existingLock = await this.readLockFile(owner, repo, issueNumber);
    if (existingLock) {
      const isStale = await this.isLockStale(existingLock);
      if (!isStale) {
        return {
          success: false,
          error: `Issue #${issueNumber} is locked by another session`,
          code: 'LOCK_HELD',
        };
      }
      await this.deleteLockFile(owner, repo, issueNumber);
    }

    try {
      const lockData = createLock(issueNumber, `${owner}/${repo}`, this.sessionId);

      // Try to create file atomically using exclusive flag
      await writeFile(lockFilePath, JSON.stringify(lockData, null, 2), { flag: 'wx' });

      return {
        success: true,
        lock: lockData,
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') {
        // File was created by another process between our check and write
        return {
          success: false,
          error: `Issue #${issueNumber} is locked by another session`,
          code: 'LOCK_HELD',
        };
      }
      return {
        success: false,
        error: `Failed to create lock: ${err.message}`,
        code: 'LOCK_CREATION_FAILED',
      };
    }
  }

  async releaseLock(owner: string, repo: string, issueNumber: number): Promise<boolean> {
    try {
      const existingLock = await this.readLockFile(owner, repo, issueNumber);
      if (!existingLock) {
        return true;
      }

      if (existingLock.sessionId !== this.sessionId) {
        return false;
      }

      await this.deleteLockFile(owner, repo, issueNumber);
      return true;
    } catch {
      return false;
    }
  }

  async forceClaim(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<{ success: boolean; previousHolder: Lock | null; lock?: Lock; error?: string }> {
    await this.ensureLocksDir();

    const existingLock = await this.readLockFile(owner, repo, issueNumber);
    const previousHolder = existingLock ? { ...existingLock } : null;

    if (existingLock) {
      await this.deleteLockFile(owner, repo, issueNumber);
    }

    // Small delay to ensure file system sync
    await new Promise((resolve) => setTimeout(resolve, 10));

    const lockFilePath = this.getLockFilePath(owner, repo, issueNumber);
    const lockData = createLock(issueNumber, `${owner}/${repo}`, this.sessionId);

    try {
      await writeFile(lockFilePath, JSON.stringify(lockData, null, 2));
      return {
        success: true,
        previousHolder,
        lock: lockData,
      };
    } catch (error) {
      return {
        success: false,
        previousHolder,
        error: `Failed to acquire lock: ${(error as Error).message}`,
      };
    }
  }

  async isLockStale(lockData: Lock): Promise<boolean> {
    const lockAge = Date.now() - new Date(lockData.acquiredAt).getTime();
    if (lockAge > LOCK_STALE_TIMEOUT_MS) {
      return true;
    }

    const processAlive = await isProcessAlive(lockData.pid);
    if (!processAlive) {
      return true;
    }

    return false;
  }

  async readLockFile(owner: string, repo: string, issueNumber: number): Promise<Lock | null> {
    const lockFilePath = this.getLockFilePath(owner, repo, issueNumber);
    try {
      const content = await readFile(lockFilePath, 'utf-8');
      const data = JSON.parse(content);
      return validateLock(data);
    } catch {
      return null;
    }
  }

  async deleteLockFile(owner: string, repo: string, issueNumber: number): Promise<void> {
    const lockFilePath = this.getLockFilePath(owner, repo, issueNumber);
    try {
      await unlink(lockFilePath);
    } catch {
      // File already deleted or doesn't exist - ignore
    }
  }

  async listLocks(): Promise<LockInfo[]> {
    await this.ensureLocksDir();
    const locks: LockInfo[] = [];

    try {
      const files = await readdir(this.locksDir);
      for (const file of files) {
        if (!file.endsWith('.lockdata')) continue;

        const parsed = parseLockFileName(file);
        if (!parsed) continue;

        const lockData = await this.readLockFile(parsed.owner, parsed.repo, parsed.issueNumber);
        if (!lockData) continue;

        const isStale = await this.isLockStale(lockData);
        locks.push({
          issueNumber: parsed.issueNumber,
          repoFullName: `${parsed.owner}/${parsed.repo}`,
          lock: lockData,
          isStale,
        });
      }
    } catch {
      // Directory may not exist yet or permission issue - return empty array
    }

    return locks;
  }

  async getLocksForSession(): Promise<LockInfo[]> {
    const allLocks = await this.listLocks();
    return allLocks.filter((l) => l.lock.sessionId === this.sessionId);
  }

  async isIssueLocked(owner: string, repo: string, issueNumber: number): Promise<boolean> {
    const lockData = await this.readLockFile(owner, repo, issueNumber);
    if (!lockData) return false;
    const isStale = await this.isLockStale(lockData);
    return !isStale;
  }

  async getLockHolder(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<{ sessionId: string; isStale: boolean } | null> {
    const lockData = await this.readLockFile(owner, repo, issueNumber);
    if (!lockData) return null;
    const isStale = await this.isLockStale(lockData);
    return { sessionId: lockData.sessionId, isStale };
  }
}

let globalLockingService: LockingService | null = null;

export function getLockingService(): LockingService {
  if (!globalLockingService) {
    const config = getConfig();
    globalLockingService = new LockingService(config.sessionId);
  }
  return globalLockingService;
}

export function initializeLockingService(sessionId: string, locksDir?: string): LockingService {
  globalLockingService = new LockingService(sessionId, locksDir);
  return globalLockingService;
}

export function resetLockingService(): void {
  globalLockingService = null;
}
