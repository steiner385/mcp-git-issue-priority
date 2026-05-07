import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { CacheService, type CachedIssues } from '../../src/services/cache.js';
import type { Issue } from '../../src/models/index.js';
import type { PrStatus } from '../../src/models/index.js';

const makeIssue = (number: number, updatedAt = '2026-01-01T00:00:00Z'): Issue => ({
  number,
  title: `Issue ${number}`,
  body: null,
  state: 'open',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: updatedAt,
  labels: [],
  assignees: [],
  html_url: `https://github.com/owner/repo/issues/${number}`,
  repository: { owner: 'owner', repo: 'repo', full_name: 'owner/repo' },
});

const makeOpenPrStatus = (prNumber = 1): PrStatus => ({
  prNumber,
  state: 'open',
  mergeable: true,
  ci: { status: 'passing', checks: [] },
  reviews: { approved: false, changesRequested: false, reviewers: [] },
  autoMerge: { enabled: false },
});

const makeMergedPrStatus = (prNumber = 1): PrStatus => ({
  ...makeOpenPrStatus(prNumber),
  state: 'merged',
  mergeable: null,
});

describe('CacheService', () => {
  let tmpDir: string;
  let cache: CacheService;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `cache-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    cache = new CacheService(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- issues ---

  describe('getIssues', () => {
    it('returns null when no cache file exists', async () => {
      expect(await cache.getIssues('owner', 'repo')).toBeNull();
    });

    it('returns cached data when fresh', async () => {
      const data: CachedIssues = { issues: [makeIssue(1)], dependencies: [[1, null]] };
      await cache.setIssues('owner', 'repo', data, '2026-05-06T12:00:00.000Z');

      const result = await cache.getIssues('owner', 'repo');

      expect(result).not.toBeNull();
      expect(result!.data.issues).toHaveLength(1);
      expect(result!.data.issues[0].number).toBe(1);
      expect(result!.data.dependencies).toEqual([[1, null]]);
      expect(result!.lastModifiedAt).toBe('2026-05-06T12:00:00.000Z');
    });

    it('returns null when cache is older than 24 hours', async () => {
      await cache.setIssues('owner', 'repo', { issues: [], dependencies: [] }, '2026-05-05T00:00:00.000Z');

      const filePath = join(tmpDir, 'owner__repo', 'issues.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      raw.fetchedAt = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      await writeFile(filePath, JSON.stringify(raw), 'utf-8');

      expect(await cache.getIssues('owner', 'repo')).toBeNull();
    });

    it('returns null and does not throw when file is corrupt JSON', async () => {
      const dir = join(tmpDir, 'owner__repo');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'issues.json'), 'NOT VALID JSON', 'utf-8');

      expect(await cache.getIssues('owner', 'repo')).toBeNull();
    });
  });

  describe('setIssues', () => {
    it('writes atomically — no leftover .tmp files after write', async () => {
      await cache.setIssues('owner', 'repo', { issues: [], dependencies: [] }, '2026-05-06T00:00:00.000Z');

      const dir = join(tmpDir, 'owner__repo');
      const files = await readdir(dir);
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));

      expect(tmpFiles).toHaveLength(0);
      expect(files).toContain('issues.json');
    });
  });

  describe('patchIssueLabels', () => {
    it('updates labels on the target issue and advances lastModifiedAt', async () => {
      const issue = { ...makeIssue(1), labels: [{ name: 'status:backlog', color: 'aaa', description: null }] };
      await cache.setIssues('owner', 'repo', { issues: [issue], dependencies: [[1, null]] }, '2026-01-01T00:00:00.000Z');

      await cache.patchIssueLabels('owner', 'repo', 1, ['status:in-progress'], ['status:backlog']);

      const result = await cache.getIssues('owner', 'repo');
      const labels = result!.data.issues[0].labels.map((l) => l.name);
      expect(labels).toContain('status:in-progress');
      expect(labels).not.toContain('status:backlog');
      expect(result!.lastModifiedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });

    it('leaves other issues untouched', async () => {
      const issues = [makeIssue(1), makeIssue(2)];
      await cache.setIssues('owner', 'repo', { issues, dependencies: [] }, '2026-01-01T00:00:00.000Z');

      await cache.patchIssueLabels('owner', 'repo', 1, ['type:bug'], []);

      const result = await cache.getIssues('owner', 'repo');
      expect(result!.data.issues).toHaveLength(2);
      expect(result!.data.issues[1].number).toBe(2);
    });

    it('is a no-op when cache is empty', async () => {
      await expect(cache.patchIssueLabels('owner', 'repo', 1, ['type:bug'], [])).resolves.not.toThrow();
    });

    it('is a no-op when issue is not in cache', async () => {
      await cache.setIssues('owner', 'repo', { issues: [makeIssue(2)], dependencies: [] }, '2026-01-01T00:00:00.000Z');
      await cache.patchIssueLabels('owner', 'repo', 999, ['type:bug'], []);

      const result = await cache.getIssues('owner', 'repo');
      expect(result!.data.issues).toHaveLength(1);
    });
  });

  describe('evictIssue', () => {
    it('removes the issue from the cache and advances lastModifiedAt', async () => {
      const issues = [makeIssue(1), makeIssue(2)];
      await cache.setIssues('owner', 'repo', { issues, dependencies: [[1, null], [2, 1]] }, '2026-01-01T00:00:00.000Z');

      await cache.evictIssue('owner', 'repo', 1);

      const result = await cache.getIssues('owner', 'repo');
      expect(result!.data.issues.map((i) => i.number)).toEqual([2]);
      expect(result!.data.dependencies.map(([n]) => n)).not.toContain(1);
      expect(result!.lastModifiedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });

    it('is a no-op when cache is empty', async () => {
      await expect(cache.evictIssue('owner', 'repo', 1)).resolves.not.toThrow();
    });
  });

  describe('addIssue', () => {
    it('appends the new issue and its dependency entry', async () => {
      await cache.setIssues('owner', 'repo', { issues: [makeIssue(1)], dependencies: [[1, null]] }, '2026-01-01T00:00:00.000Z');

      const newIssue = makeIssue(2, '2026-06-01T00:00:00.000Z');
      await cache.addIssue('owner', 'repo', newIssue);

      const result = await cache.getIssues('owner', 'repo');
      expect(result!.data.issues.map((i) => i.number)).toContain(2);
      expect(result!.data.dependencies.map(([n]) => n)).toContain(2);
      expect(result!.lastModifiedAt).toBe('2026-06-01T00:00:00.000Z');
    });

    it('is a no-op when cache is empty', async () => {
      await expect(cache.addIssue('owner', 'repo', makeIssue(1))).resolves.not.toThrow();
      expect(await cache.getIssues('owner', 'repo')).toBeNull();
    });
  });

  describe('invalidateIssues', () => {
    it('deletes the cache file', async () => {
      await cache.setIssues('owner', 'repo', { issues: [], dependencies: [] }, '2026-05-06T00:00:00.000Z');
      await cache.invalidateIssues('owner', 'repo');

      expect(await cache.getIssues('owner', 'repo')).toBeNull();
    });

    it('does not throw when file does not exist', async () => {
      await expect(cache.invalidateIssues('owner', 'repo')).resolves.not.toThrow();
    });
  });

  // --- labels ---

  describe('getLabels', () => {
    it('returns null when no cache file exists', async () => {
      expect(await cache.getLabels('owner', 'repo')).toBeNull();
    });

    it('returns cached labels when within TTL', async () => {
      await cache.setLabels('owner', 'repo', ['priority:high', 'type:bug']);

      expect(await cache.getLabels('owner', 'repo')).toEqual(['priority:high', 'type:bug']);
    });

    it('returns null when TTL has expired', async () => {
      await cache.setLabels('owner', 'repo', ['priority:high']);

      const filePath = join(tmpDir, 'owner__repo', 'labels.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      raw.fetchedAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      await writeFile(filePath, JSON.stringify(raw), 'utf-8');

      expect(await cache.getLabels('owner', 'repo')).toBeNull();
    });
  });

  describe('invalidateLabels', () => {
    it('deletes the labels cache file', async () => {
      await cache.setLabels('owner', 'repo', ['priority:high']);
      await cache.invalidateLabels('owner', 'repo');

      expect(await cache.getLabels('owner', 'repo')).toBeNull();
    });

    it('does not throw when file does not exist', async () => {
      await expect(cache.invalidateLabels('owner', 'repo')).resolves.not.toThrow();
    });
  });

  // --- PR status ---

  describe('getPrStatus', () => {
    it('returns null when no cache file exists', async () => {
      expect(await cache.getPrStatus('owner', 'repo', 1)).toBeNull();
    });

    it('returns cached status for open PR within TTL', async () => {
      const status = makeOpenPrStatus(42);
      await cache.setPrStatus('owner', 'repo', 42, status);

      expect(await cache.getPrStatus('owner', 'repo', 42)).toEqual(status);
    });

    it('returns null for open PR when TTL has expired', async () => {
      await cache.setPrStatus('owner', 'repo', 1, makeOpenPrStatus());

      const filePath = join(tmpDir, 'owner__repo', 'pr-1.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      raw.fetchedAt = Date.now() - 120_000; // 2 minutes ago
      await writeFile(filePath, JSON.stringify(raw), 'utf-8');

      expect(await cache.getPrStatus('owner', 'repo', 1)).toBeNull();
    });

    it('returns merged PR status even when fetched a week ago (null TTL = never-expire)', async () => {
      await cache.setPrStatus('owner', 'repo', 1, makeMergedPrStatus());

      const filePath = join(tmpDir, 'owner__repo', 'pr-1.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      raw.fetchedAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
      await writeFile(filePath, JSON.stringify(raw), 'utf-8');

      expect(await cache.getPrStatus('owner', 'repo', 1)).toEqual(makeMergedPrStatus());
    });

    it('stores null TTL for merged PR', async () => {
      await cache.setPrStatus('owner', 'repo', 1, makeMergedPrStatus());

      const filePath = join(tmpDir, 'owner__repo', 'pr-1.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(raw.ttl).toBeNull();
    });

    it('stores numeric TTL for open PR', async () => {
      await cache.setPrStatus('owner', 'repo', 1, makeOpenPrStatus());

      const filePath = join(tmpDir, 'owner__repo', 'pr-1.json');
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(typeof raw.ttl).toBe('number');
      expect(raw.ttl).toBeGreaterThan(0);
    });
  });
});
