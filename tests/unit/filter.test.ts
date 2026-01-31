import { describe, it, expect } from 'vitest';
import { applyFilters, type SelectionFilter } from '../../src/models/selection-filter.js';
import type { Issue } from '../../src/models/issue.js';

const createMockIssue = (
  number: number,
  labels: string[],
  assignees: string[] = []
): Issue => ({
  number,
  title: `Test Issue ${number}`,
  body: null,
  state: 'open',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  labels: labels.map((name) => ({ name, color: '000000', description: null })),
  assignees: assignees.map((login) => ({ login })),
  html_url: `https://github.com/owner/repo/issues/${number}`,
  repository: { owner: 'owner', repo: 'repo', full_name: 'owner/repo' },
});

describe('Selection Filters', () => {
  const testIssues: Issue[] = [
    createMockIssue(1, ['priority:high', 'type:bug', 'status:backlog']),
    createMockIssue(2, ['priority:medium', 'type:feature', 'status:backlog']),
    createMockIssue(3, ['priority:low', 'type:chore', 'status:in-progress']),
    createMockIssue(4, ['priority:critical', 'type:docs', 'status:backlog']),
    createMockIssue(5, ['priority:high', 'type:bug', 'status:backlog'], ['assignee1']),
  ];

  describe('applyFilters', () => {
    it('excludes issues with status:in-progress', () => {
      const filtered = applyFilters(testIssues, {});

      expect(filtered.length).toBe(3);
      expect(filtered.find((i) => i.number === 3)).toBeUndefined();
    });

    it('excludes issues with assignees', () => {
      const filtered = applyFilters(testIssues, {});

      expect(filtered.find((i) => i.number === 5)).toBeUndefined();
    });

    it('filters by includeTypes (bug only)', () => {
      const filter: SelectionFilter = { includeTypes: ['bug'] };
      const filtered = applyFilters(testIssues, filter);

      expect(filtered.length).toBe(1);
      expect(filtered[0].number).toBe(1);
    });

    it('filters by includeTypes (multiple types)', () => {
      const filter: SelectionFilter = { includeTypes: ['bug', 'feature'] };
      const filtered = applyFilters(testIssues, filter);

      expect(filtered.length).toBe(2);
      expect(filtered.map((i) => i.number)).toContain(1);
      expect(filtered.map((i) => i.number)).toContain(2);
    });

    it('filters by excludeTypes (exclude bug)', () => {
      const filter: SelectionFilter = { excludeTypes: ['bug'] };
      const filtered = applyFilters(testIssues, filter);

      expect(filtered.length).toBe(2);
      expect(filtered.find((i) => i.number === 1)).toBeUndefined();
    });

    it('filters by excludeTypes (multiple types)', () => {
      const filter: SelectionFilter = { excludeTypes: ['bug', 'feature'] };
      const filtered = applyFilters(testIssues, filter);

      expect(filtered.length).toBe(1);
      expect(filtered[0].number).toBe(4);
    });

    it('combines includeTypes and excludeTypes', () => {
      const filter: SelectionFilter = {
        includeTypes: ['bug', 'feature'],
        excludeTypes: ['bug'],
      };
      const filtered = applyFilters(testIssues, filter);

      expect(filtered.length).toBe(1);
      expect(filtered[0].number).toBe(2);
    });

    it('returns empty array when no issues match', () => {
      const filter: SelectionFilter = { includeTypes: ['docs'] };
      const filtered = applyFilters(testIssues, filter);

      expect(filtered.length).toBe(1);
      expect(filtered[0].number).toBe(4);
    });

    it('handles empty filter gracefully', () => {
      const filtered = applyFilters(testIssues, {});

      expect(filtered.length).toBe(3);
    });

    it('handles issues without type labels', () => {
      const issuesWithoutType = [
        createMockIssue(10, ['priority:high', 'status:backlog']),
        createMockIssue(11, ['priority:medium', 'type:bug', 'status:backlog']),
      ];

      const filter: SelectionFilter = { includeTypes: ['bug'] };
      const filtered = applyFilters(issuesWithoutType, filter);

      expect(filtered.length).toBe(1);
      expect(filtered[0].number).toBe(11);
    });

    it('includes issues without type labels when excludeTypes is used', () => {
      const issuesWithoutType = [
        createMockIssue(10, ['priority:high', 'status:backlog']),
        createMockIssue(11, ['priority:medium', 'type:bug', 'status:backlog']),
      ];

      const filter: SelectionFilter = { excludeTypes: ['bug'] };
      const filtered = applyFilters(issuesWithoutType, filter);

      expect(filtered.length).toBe(1);
      expect(filtered[0].number).toBe(10);
    });
  });
});
