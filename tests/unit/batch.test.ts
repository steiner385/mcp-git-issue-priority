import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { BatchService } from '../../src/services/batch.js';

describe('BatchService', () => {
  let batchService: BatchService;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `batch-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    batchService = new BatchService(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('createBatch', () => {
    it('creates and persists batch state', async () => {
      const batch = await batchService.createBatch('owner/repo', [1, 2, 3]);

      expect(batch.repository).toBe('owner/repo');
      expect(batch.queue).toEqual([1, 2, 3]);
      expect(batch.totalCount).toBe(3);

      const retrieved = await batchService.getBatch(batch.batchId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.batchId).toBe(batch.batchId);
    });
  });

  describe('startNextIssue', () => {
    it('pops issue from queue and sets as current', async () => {
      const batch = await batchService.createBatch('owner/repo', [1, 2, 3]);

      const issueNumber = await batchService.startNextIssue(batch.batchId);

      expect(issueNumber).toBe(1);

      const updated = await batchService.getBatch(batch.batchId);
      expect(updated?.currentIssue).toBe(1);
      expect(updated?.queue).toEqual([2, 3]);
    });

    it('returns null when queue is empty', async () => {
      const batch = await batchService.createBatch('owner/repo', []);

      const issueNumber = await batchService.startNextIssue(batch.batchId);

      expect(issueNumber).toBeNull();
    });
  });

  describe('completeCurrentIssue', () => {
    it('moves current issue to completed', async () => {
      const batch = await batchService.createBatch('owner/repo', [1, 2]);
      await batchService.startNextIssue(batch.batchId);
      await batchService.setPrNumber(batch.batchId, 100);

      await batchService.completeCurrentIssue(batch.batchId);

      const updated = await batchService.getBatch(batch.batchId);
      expect(updated?.completedCount).toBe(1);
      expect(updated?.completed).toHaveLength(1);
      expect(updated?.completed[0].issue).toBe(1);
      expect(updated?.completed[0].pr).toBe(100);
      expect(updated?.currentIssue).toBeNull();
      expect(updated?.currentPr).toBeNull();
    });
  });
});
