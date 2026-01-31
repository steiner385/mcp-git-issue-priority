import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculatePriorityScore,
  comparePriorityScores,
  sortByPriority,
  calculateAgeInDays,
  PRIORITY_BASE_POINTS,
  MAX_AGE_BONUS,
  BLOCKING_MULTIPLIER,
} from '../../src/models/priority-score.js';
import type { Issue } from '../../src/models/issue.js';

const createMockIssue = (
  number: number,
  labels: string[],
  createdAt: string = '2024-01-01T00:00:00Z'
): Issue => ({
  number,
  title: `Test Issue ${number}`,
  body: null,
  state: 'open',
  created_at: createdAt,
  updated_at: createdAt,
  labels: labels.map((name) => ({ name, color: '000000', description: null })),
  assignees: [],
  html_url: `https://github.com/owner/repo/issues/${number}`,
  repository: { owner: 'owner', repo: 'repo', full_name: 'owner/repo' },
});

describe('Priority Score Calculation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('PRIORITY_BASE_POINTS', () => {
    it('has correct base points for each priority level', () => {
      expect(PRIORITY_BASE_POINTS['priority:critical']).toBe(1000);
      expect(PRIORITY_BASE_POINTS['priority:high']).toBe(100);
      expect(PRIORITY_BASE_POINTS['priority:medium']).toBe(10);
      expect(PRIORITY_BASE_POINTS['priority:low']).toBe(1);
    });
  });

  describe('calculateAgeInDays', () => {
    it('calculates correct age in days', () => {
      expect(calculateAgeInDays('2024-01-01T00:00:00Z')).toBe(14);
    });

    it('returns 0 for issues created today', () => {
      expect(calculateAgeInDays('2024-01-15T00:00:00Z')).toBe(0);
    });

    it('returns correct age for older issues', () => {
      expect(calculateAgeInDays('2023-12-15T00:00:00Z')).toBe(31);
    });
  });

  describe('calculatePriorityScore', () => {
    it('calculates score for critical priority', () => {
      const issue = createMockIssue(1, ['priority:critical', 'type:bug']);
      const score = calculatePriorityScore(issue);

      expect(score.basePoints).toBe(1000);
      expect(score.ageBonus).toBe(14);
      expect(score.blockingMultiplier).toBe(1.0);
      expect(score.totalScore).toBe(1014);
    });

    it('calculates score for high priority', () => {
      const issue = createMockIssue(2, ['priority:high', 'type:feature']);
      const score = calculatePriorityScore(issue);

      expect(score.basePoints).toBe(100);
      expect(score.ageBonus).toBe(14);
      expect(score.totalScore).toBe(114);
    });

    it('calculates score for medium priority', () => {
      const issue = createMockIssue(3, ['priority:medium', 'type:chore']);
      const score = calculatePriorityScore(issue);

      expect(score.basePoints).toBe(10);
      expect(score.totalScore).toBe(24);
    });

    it('calculates score for low priority', () => {
      const issue = createMockIssue(4, ['priority:low', 'type:docs']);
      const score = calculatePriorityScore(issue);

      expect(score.basePoints).toBe(1);
      expect(score.totalScore).toBe(15);
    });

    it('caps age bonus at MAX_AGE_BONUS', () => {
      const issue = createMockIssue(5, ['priority:high'], '2023-01-01T00:00:00Z');
      const score = calculatePriorityScore(issue);

      expect(score.ageBonus).toBe(MAX_AGE_BONUS);
      expect(score.totalScore).toBe(130);
    });

    it('applies blocking multiplier when blocking label present', () => {
      const issue = createMockIssue(6, ['priority:high', 'blocking']);
      const score = calculatePriorityScore(issue);

      expect(score.blockingMultiplier).toBe(BLOCKING_MULTIPLIER);
      expect(score.totalScore).toBe((100 + 14) * 1.5);
    });

    it('applies blocking multiplier when blocker label present', () => {
      const issue = createMockIssue(7, ['priority:medium', 'blocker']);
      const score = calculatePriorityScore(issue);

      expect(score.blockingMultiplier).toBe(BLOCKING_MULTIPLIER);
      expect(score.totalScore).toBe((10 + 14) * 1.5);
    });

    it('returns 0 base points for missing priority label', () => {
      const issue = createMockIssue(8, ['type:bug']);
      const score = calculatePriorityScore(issue);

      expect(score.basePoints).toBe(0);
      expect(score.totalScore).toBe(14);
    });
  });

  describe('comparePriorityScores', () => {
    it('higher score comes first', () => {
      const scoreA = { issueNumber: 1, basePoints: 100, ageBonus: 10, blockingMultiplier: 1, totalScore: 110 };
      const scoreB = { issueNumber: 2, basePoints: 10, ageBonus: 10, blockingMultiplier: 1, totalScore: 20 };

      expect(comparePriorityScores(scoreA, scoreB)).toBeLessThan(0);
      expect(comparePriorityScores(scoreB, scoreA)).toBeGreaterThan(0);
    });

    it('uses issue number as tiebreaker (FIFO - lower number first)', () => {
      const scoreA = { issueNumber: 5, basePoints: 100, ageBonus: 10, blockingMultiplier: 1, totalScore: 110 };
      const scoreB = { issueNumber: 3, basePoints: 100, ageBonus: 10, blockingMultiplier: 1, totalScore: 110 };

      expect(comparePriorityScores(scoreA, scoreB)).toBeGreaterThan(0);
      expect(comparePriorityScores(scoreB, scoreA)).toBeLessThan(0);
    });

    it('returns 0 for identical scores and issue numbers', () => {
      const scoreA = { issueNumber: 1, basePoints: 100, ageBonus: 10, blockingMultiplier: 1, totalScore: 110 };
      const scoreB = { issueNumber: 1, basePoints: 100, ageBonus: 10, blockingMultiplier: 1, totalScore: 110 };

      expect(comparePriorityScores(scoreA, scoreB)).toBe(0);
    });
  });

  describe('sortByPriority', () => {
    it('sorts issues by priority score descending', () => {
      const issues = [
        createMockIssue(1, ['priority:low']),
        createMockIssue(2, ['priority:critical']),
        createMockIssue(3, ['priority:medium']),
        createMockIssue(4, ['priority:high']),
      ];

      const sorted = sortByPriority(issues);

      expect(sorted[0].number).toBe(2);
      expect(sorted[1].number).toBe(4);
      expect(sorted[2].number).toBe(3);
      expect(sorted[3].number).toBe(1);
    });

    it('uses FIFO for equal scores', () => {
      const issues = [
        createMockIssue(5, ['priority:high']),
        createMockIssue(2, ['priority:high']),
        createMockIssue(8, ['priority:high']),
      ];

      const sorted = sortByPriority(issues);

      expect(sorted[0].number).toBe(2);
      expect(sorted[1].number).toBe(5);
      expect(sorted[2].number).toBe(8);
    });

    it('handles blocking issues correctly', () => {
      const issues = [
        createMockIssue(1, ['priority:high']),
        createMockIssue(2, ['priority:medium', 'blocking']),
      ];

      const sorted = sortByPriority(issues);

      expect(sorted[0].number).toBe(1);
      expect(sorted[1].number).toBe(2);
    });
  });
});
