import { describe, it, expect } from 'vitest';
import {
  getPriorityLabel,
  getTypeLabel,
  getStatusLabel,
  hasLabel,
  LABEL_DEFINITIONS,
  type Issue,
} from '../../src/models/issue.js';

const createMockIssue = (labels: string[]): Issue => ({
  number: 1,
  title: 'Test Issue',
  body: null,
  state: 'open',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  labels: labels.map((name) => ({ name, color: '000000', description: null })),
  assignees: [],
  html_url: 'https://github.com/owner/repo/issues/1',
  repository: { owner: 'owner', repo: 'repo', full_name: 'owner/repo' },
});

describe('Label Helpers', () => {
  describe('getPriorityLabel', () => {
    it('returns priority:critical when present', () => {
      const issue = createMockIssue(['priority:critical', 'type:bug']);
      expect(getPriorityLabel(issue)).toBe('priority:critical');
    });

    it('returns priority:high when present', () => {
      const issue = createMockIssue(['priority:high', 'type:feature']);
      expect(getPriorityLabel(issue)).toBe('priority:high');
    });

    it('returns priority:medium when present', () => {
      const issue = createMockIssue(['priority:medium']);
      expect(getPriorityLabel(issue)).toBe('priority:medium');
    });

    it('returns priority:low when present', () => {
      const issue = createMockIssue(['priority:low']);
      expect(getPriorityLabel(issue)).toBe('priority:low');
    });

    it('returns null when no priority label', () => {
      const issue = createMockIssue(['type:bug']);
      expect(getPriorityLabel(issue)).toBeNull();
    });

    it('returns null for invalid priority label', () => {
      const issue = createMockIssue(['priority:invalid']);
      expect(getPriorityLabel(issue)).toBeNull();
    });
  });

  describe('getTypeLabel', () => {
    it('returns type:bug when present', () => {
      const issue = createMockIssue(['type:bug', 'priority:high']);
      expect(getTypeLabel(issue)).toBe('type:bug');
    });

    it('returns type:feature when present', () => {
      const issue = createMockIssue(['type:feature']);
      expect(getTypeLabel(issue)).toBe('type:feature');
    });

    it('returns type:chore when present', () => {
      const issue = createMockIssue(['type:chore']);
      expect(getTypeLabel(issue)).toBe('type:chore');
    });

    it('returns type:docs when present', () => {
      const issue = createMockIssue(['type:docs']);
      expect(getTypeLabel(issue)).toBe('type:docs');
    });

    it('returns null when no type label', () => {
      const issue = createMockIssue(['priority:high']);
      expect(getTypeLabel(issue)).toBeNull();
    });
  });

  describe('getStatusLabel', () => {
    it('returns status:backlog when present', () => {
      const issue = createMockIssue(['status:backlog']);
      expect(getStatusLabel(issue)).toBe('status:backlog');
    });

    it('returns status:in-progress when present', () => {
      const issue = createMockIssue(['status:in-progress']);
      expect(getStatusLabel(issue)).toBe('status:in-progress');
    });

    it('returns status:in-review when present', () => {
      const issue = createMockIssue(['status:in-review']);
      expect(getStatusLabel(issue)).toBe('status:in-review');
    });

    it('returns status:blocked when present', () => {
      const issue = createMockIssue(['status:blocked']);
      expect(getStatusLabel(issue)).toBe('status:blocked');
    });

    it('returns null when no status label', () => {
      const issue = createMockIssue(['type:bug']);
      expect(getStatusLabel(issue)).toBeNull();
    });
  });

  describe('hasLabel', () => {
    it('returns true when label exists', () => {
      const issue = createMockIssue(['blocking', 'type:bug']);
      expect(hasLabel(issue, 'blocking')).toBe(true);
    });

    it('returns false when label does not exist', () => {
      const issue = createMockIssue(['type:bug']);
      expect(hasLabel(issue, 'blocking')).toBe(false);
    });
  });

  describe('LABEL_DEFINITIONS', () => {
    it('has all priority labels defined', () => {
      expect(LABEL_DEFINITIONS.priority['priority:critical']).toBeDefined();
      expect(LABEL_DEFINITIONS.priority['priority:high']).toBeDefined();
      expect(LABEL_DEFINITIONS.priority['priority:medium']).toBeDefined();
      expect(LABEL_DEFINITIONS.priority['priority:low']).toBeDefined();
    });

    it('has all type labels defined', () => {
      expect(LABEL_DEFINITIONS.type['type:bug']).toBeDefined();
      expect(LABEL_DEFINITIONS.type['type:feature']).toBeDefined();
      expect(LABEL_DEFINITIONS.type['type:chore']).toBeDefined();
      expect(LABEL_DEFINITIONS.type['type:docs']).toBeDefined();
    });

    it('has all status labels defined', () => {
      expect(LABEL_DEFINITIONS.status['status:backlog']).toBeDefined();
      expect(LABEL_DEFINITIONS.status['status:in-progress']).toBeDefined();
      expect(LABEL_DEFINITIONS.status['status:in-review']).toBeDefined();
      expect(LABEL_DEFINITIONS.status['status:blocked']).toBeDefined();
    });

    it('has correct colors for priority labels', () => {
      expect(LABEL_DEFINITIONS.priority['priority:critical'].color).toBe('b60205');
      expect(LABEL_DEFINITIONS.priority['priority:high'].color).toBe('d93f0b');
      expect(LABEL_DEFINITIONS.priority['priority:medium'].color).toBe('fbca04');
      expect(LABEL_DEFINITIONS.priority['priority:low'].color).toBe('0e8a16');
    });
  });
});
