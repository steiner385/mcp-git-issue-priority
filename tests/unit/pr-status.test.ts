import { describe, it, expect } from 'vitest';
import {
  PrStatusSchema,
  CheckStatusSchema,
  validatePrStatus,
  type PrStatus,
} from '../../src/models/pr-status.js';

describe('PrStatus', () => {
  describe('CheckStatusSchema', () => {
    it('validates check status with all possible statuses', () => {
      const statuses = ['queued', 'in_progress', 'success', 'failure', 'neutral', 'skipped'];
      for (const status of statuses) {
        const result = CheckStatusSchema.safeParse({ name: 'test-check', status });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid check status', () => {
      const result = CheckStatusSchema.safeParse({ name: 'test-check', status: 'invalid' });
      expect(result.success).toBe(false);
    });
  });

  describe('PrStatusSchema', () => {
    it('validates complete PR status', () => {
      const status: PrStatus = {
        prNumber: 42,
        state: 'open',
        mergeable: true,
        ci: {
          status: 'passing',
          checks: [
            { name: 'build', status: 'success' },
            { name: 'test', status: 'success' },
          ],
        },
        reviews: {
          approved: true,
          changesRequested: false,
          reviewers: ['alice', 'bob'],
        },
        autoMerge: {
          enabled: true,
        },
      };

      expect(validatePrStatus(status)).not.toBeNull();
    });

    it('validates merged PR', () => {
      const status: PrStatus = {
        prNumber: 42,
        state: 'merged',
        mergeable: null,
        ci: { status: 'passing', checks: [] },
        reviews: { approved: true, changesRequested: false, reviewers: [] },
        autoMerge: { enabled: false },
      };

      expect(validatePrStatus(status)).not.toBeNull();
    });

    it('rejects invalid PR number', () => {
      const result = PrStatusSchema.safeParse({
        prNumber: -1,
        state: 'open',
        mergeable: true,
        ci: { status: 'passing', checks: [] },
        reviews: { approved: false, changesRequested: false, reviewers: [] },
        autoMerge: { enabled: false },
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid state', () => {
      const result = PrStatusSchema.safeParse({
        prNumber: 42,
        state: 'invalid',
        mergeable: true,
        ci: { status: 'passing', checks: [] },
        reviews: { approved: false, changesRequested: false, reviewers: [] },
        autoMerge: { enabled: false },
      });
      expect(result.success).toBe(false);
    });
  });
});
