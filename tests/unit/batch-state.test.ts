import { describe, it, expect } from 'vitest';
import { createBatchState, validateBatchState } from '../../src/models/batch-state.js';

describe('BatchState', () => {
  describe('createBatchState', () => {
    it('creates valid batch state with correct defaults', () => {
      const state = createBatchState('owner/repo', 5, [1, 2, 3, 4, 5]);

      expect(state.batchId).toMatch(/^[0-9a-f-]{36}$/);
      expect(state.repository).toBe('owner/repo');
      expect(state.totalCount).toBe(5);
      expect(state.completedCount).toBe(0);
      expect(state.currentIssue).toBeNull();
      expect(state.currentPr).toBeNull();
      expect(state.queue).toEqual([1, 2, 3, 4, 5]);
      expect(state.completed).toEqual([]);
      expect(state.status).toBe('in_progress');
    });
  });

  describe('validateBatchState', () => {
    it('validates correct batch state', () => {
      const state = createBatchState('owner/repo', 3, [1, 2, 3]);
      expect(validateBatchState(state)).not.toBeNull();
    });

    it('returns null for invalid batch state', () => {
      expect(validateBatchState({ invalid: true })).toBeNull();
    });
  });
});
