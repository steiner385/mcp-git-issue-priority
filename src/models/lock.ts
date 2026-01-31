import { z } from 'zod';

export const LockSchema = z.object({
  issueNumber: z.number().int().positive(),
  repoFullName: z.string().regex(/^[^/]+\/[^/]+$/),
  pid: z.number().int().positive(),
  sessionId: z.string().uuid(),
  acquiredAt: z.string().datetime(),
  lastUpdated: z.string().datetime(),
});

export type Lock = z.infer<typeof LockSchema>;

export function createLock(
  issueNumber: number,
  repoFullName: string,
  sessionId: string,
  pid: number = process.pid
): Lock {
  const now = new Date().toISOString();
  return {
    issueNumber,
    repoFullName,
    pid,
    sessionId,
    acquiredAt: now,
    lastUpdated: now,
  };
}

export function getLockFileName(owner: string, repo: string, issueNumber: number): string {
  return `${owner}_${repo}_${issueNumber}.lockdata`;
}

export function parseLockFileName(
  fileName: string
): { owner: string; repo: string; issueNumber: number } | null {
  const match = fileName.match(/^([^_]+)_([^_]+)_(\d+)\.lockdata$/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10),
  };
}

export function validateLock(data: unknown): Lock | null {
  const result = LockSchema.safeParse(data);
  return result.success ? result.data : null;
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const LOCK_STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
