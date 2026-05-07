import { readFile, writeFile, unlink, mkdir, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { getCacheDir } from '../config/index.js';
import type { Issue } from '../models/index.js';
import type { PrStatus } from '../models/index.js';

const LABELS_TTL_MS = 60 * 60 * 1000;
const PR_OPEN_TTL_MS = 60 * 1_000;
const ISSUES_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

interface CacheEnvelope<T> {
  v: 1;
  fetchedAt: number;
  lastModifiedAt?: string;
  ttl: number | null;
  data: T;
}

export interface CachedIssues {
  issues: Issue[];
  dependencies: [number, number | null][];
}

async function readEnvelope<T>(filePath: string): Promise<CacheEnvelope<T> | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (parsed.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isExpired(envelope: CacheEnvelope<unknown>): boolean {
  if (envelope.ttl === null) return false;
  return Date.now() - envelope.fetchedAt > envelope.ttl;
}

async function atomicWrite<T>(filePath: string, envelope: CacheEnvelope<T>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(envelope), 'utf-8');
    await rename(tmp, filePath);
  } catch (err) {
    try { await unlink(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

export class CacheService {
  constructor(private readonly cacheDir: string) {}

  private issuesPath(owner: string, repo: string): string {
    return join(this.cacheDir, `${owner}__${repo}`, 'issues.json');
  }

  private labelsPath(owner: string, repo: string): string {
    return join(this.cacheDir, `${owner}__${repo}`, 'labels.json');
  }

  private prPath(owner: string, repo: string, prNumber: number): string {
    return join(this.cacheDir, `${owner}__${repo}`, `pr-${prNumber}.json`);
  }

  async getIssues(
    owner: string,
    repo: string
  ): Promise<{ data: CachedIssues; lastModifiedAt: string } | null> {
    const envelope = await readEnvelope<CachedIssues>(this.issuesPath(owner, repo));
    if (!envelope) return null;
    if (Date.now() - envelope.fetchedAt > ISSUES_MAX_AGE_MS) return null;
    if (!envelope.lastModifiedAt) return null;
    return { data: envelope.data, lastModifiedAt: envelope.lastModifiedAt };
  }

  async setIssues(
    owner: string,
    repo: string,
    data: CachedIssues,
    lastModifiedAt: string
  ): Promise<void> {
    try {
      await atomicWrite<CachedIssues>(this.issuesPath(owner, repo), {
        v: 1,
        fetchedAt: Date.now(),
        lastModifiedAt,
        ttl: null,
        data,
      });
    } catch (err) {
      console.error(`[cache] setIssues failed: ${(err as Error).message}`);
    }
  }

  async invalidateIssues(owner: string, repo: string): Promise<void> {
    try {
      await unlink(this.issuesPath(owner, repo));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[cache] invalidateIssues failed: ${(err as Error).message}`);
      }
    }
  }

  async getLabels(owner: string, repo: string): Promise<string[] | null> {
    const envelope = await readEnvelope<string[]>(this.labelsPath(owner, repo));
    if (!envelope || isExpired(envelope)) return null;
    return envelope.data;
  }

  async setLabels(owner: string, repo: string, names: string[]): Promise<void> {
    try {
      await atomicWrite<string[]>(this.labelsPath(owner, repo), {
        v: 1,
        fetchedAt: Date.now(),
        ttl: LABELS_TTL_MS,
        data: names,
      });
    } catch (err) {
      console.error(`[cache] setLabels failed: ${(err as Error).message}`);
    }
  }

  async invalidateLabels(owner: string, repo: string): Promise<void> {
    try {
      await unlink(this.labelsPath(owner, repo));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[cache] invalidateLabels failed: ${(err as Error).message}`);
      }
    }
  }

  async getPrStatus(owner: string, repo: string, prNumber: number): Promise<PrStatus | null> {
    const envelope = await readEnvelope<PrStatus>(this.prPath(owner, repo, prNumber));
    if (!envelope || isExpired(envelope)) return null;
    return envelope.data;
  }

  async setPrStatus(
    owner: string,
    repo: string,
    prNumber: number,
    status: PrStatus
  ): Promise<void> {
    const isTerminal = status.state === 'merged' || status.state === 'closed';
    try {
      await atomicWrite<PrStatus>(this.prPath(owner, repo, prNumber), {
        v: 1,
        fetchedAt: Date.now(),
        ttl: isTerminal ? null : PR_OPEN_TTL_MS,
        data: status,
      });
    } catch (err) {
      console.error(`[cache] setPrStatus failed: ${(err as Error).message}`);
    }
  }
}

let globalCacheService: CacheService | null = null;

export function getCacheService(): CacheService {
  if (!globalCacheService) {
    globalCacheService = new CacheService(getCacheDir());
  }
  return globalCacheService;
}

export function initializeCacheService(cacheDir?: string): CacheService {
  globalCacheService = new CacheService(cacheDir ?? getCacheDir());
  return globalCacheService;
}

export function resetCacheService(): void {
  globalCacheService = null;
}
