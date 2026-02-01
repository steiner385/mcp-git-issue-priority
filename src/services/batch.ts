import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { lock } from 'proper-lockfile';
import {
  type BatchState,
  createBatchState,
  validateBatchState,
} from '../models/batch-state.js';
import { getBatchesDir, ensureDirectories } from '../config/index.js';

export class BatchService {
  private batchesDir: string;
  // Track when current issue was started (not persisted, but sufficient for single-session batches)
  private issueStartTimes: Map<string, string> = new Map();

  constructor(batchesDir?: string) {
    this.batchesDir = batchesDir ?? getBatchesDir();
  }

  private getBatchFilePath(batchId: string): string {
    return join(this.batchesDir, `${batchId}.json`);
  }

  /**
   * Execute an operation with file locking to prevent race conditions.
   * Uses proper-lockfile to ensure exclusive access during read-modify-write operations.
   */
  private async withLock<T>(batchId: string, operation: () => Promise<T>): Promise<T> {
    const filePath = this.getBatchFilePath(batchId);
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lock(filePath, { retries: 3 });
      return await operation();
    } finally {
      if (release) {
        await release();
      }
    }
  }

  async createBatch(repository: string, issueNumbers: number[]): Promise<BatchState> {
    await ensureDirectories();
    const batch = createBatchState(repository, issueNumbers.length, issueNumbers);
    await this.saveBatch(batch);
    return batch;
  }

  async getBatch(batchId: string): Promise<BatchState | null> {
    try {
      const content = await readFile(this.getBatchFilePath(batchId), 'utf-8');
      return validateBatchState(JSON.parse(content));
    } catch {
      return null;
    }
  }

  async saveBatch(batch: BatchState): Promise<void> {
    await writeFile(this.getBatchFilePath(batch.batchId), JSON.stringify(batch, null, 2));
  }

  async startNextIssue(batchId: string): Promise<number | null> {
    return this.withLock(batchId, async () => {
      const batch = await this.getBatch(batchId);
      if (!batch || batch.queue.length === 0) return null;

      const issueNumber = batch.queue.shift()!;
      batch.currentIssue = issueNumber;
      // Track when this issue was started for accurate timing
      this.issueStartTimes.set(batchId, new Date().toISOString());
      await this.saveBatch(batch);
      return issueNumber;
    });
  }

  async setPrNumber(batchId: string, prNumber: number): Promise<void> {
    return this.withLock(batchId, async () => {
      const batch = await this.getBatch(batchId);
      if (!batch) return;

      batch.currentPr = prNumber;
      await this.saveBatch(batch);
    });
  }

  async completeCurrentIssue(batchId: string): Promise<void> {
    return this.withLock(batchId, async () => {
      const batch = await this.getBatch(batchId);
      if (!batch || !batch.currentIssue || !batch.currentPr) return;

      // Use tracked issue start time, or fall back to current time if not available
      const issueStartedAt = this.issueStartTimes.get(batchId) ?? new Date().toISOString();

      batch.completed.push({
        issue: batch.currentIssue,
        pr: batch.currentPr,
        startedAt: issueStartedAt,
        mergedAt: new Date().toISOString(),
      });
      batch.completedCount++;
      batch.currentIssue = null;
      batch.currentPr = null;

      // Clean up the start time tracking
      this.issueStartTimes.delete(batchId);

      if (batch.queue.length === 0) {
        batch.status = 'completed';
      }

      await this.saveBatch(batch);
    });
  }

  async abandonBatch(batchId: string): Promise<void> {
    return this.withLock(batchId, async () => {
      const batch = await this.getBatch(batchId);
      if (!batch) return;

      batch.status = 'abandoned';
      await this.saveBatch(batch);
    });
  }

  async timeoutBatch(batchId: string): Promise<void> {
    return this.withLock(batchId, async () => {
      const batch = await this.getBatch(batchId);
      if (!batch) return;

      batch.status = 'timeout';
      await this.saveBatch(batch);
    });
  }
}

let globalBatchService: BatchService | null = null;

export function getBatchService(): BatchService {
  if (!globalBatchService) {
    globalBatchService = new BatchService();
  }
  return globalBatchService;
}

export function resetBatchService(): void {
  globalBatchService = null;
}
