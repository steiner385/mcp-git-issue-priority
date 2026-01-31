import { describe, it, expect } from 'vitest';
import { formatIssueBody } from '../../src/tools/create-issue.js';

describe('Issue Body Template', () => {
  describe('formatIssueBody', () => {
    it('formats body with all fields', () => {
      const body = formatIssueBody({
        title: 'Test Issue',
        context: 'This is the context',
        acceptanceCriteria: ['Criterion 1', 'Criterion 2'],
        technicalNotes: 'Some technical notes',
      });

      expect(body).toContain('## Summary');
      expect(body).toContain('Test Issue');
      expect(body).toContain('## Context');
      expect(body).toContain('This is the context');
      expect(body).toContain('## Acceptance Criteria');
      expect(body).toContain('- [ ] Criterion 1');
      expect(body).toContain('- [ ] Criterion 2');
      expect(body).toContain('## Technical Notes');
      expect(body).toContain('Some technical notes');
    });

    it('formats body without optional fields', () => {
      const body = formatIssueBody({
        title: 'Simple Issue',
      });

      expect(body).toContain('## Summary');
      expect(body).toContain('Simple Issue');
      expect(body).not.toContain('## Context');
      expect(body).not.toContain('## Acceptance Criteria');
      expect(body).not.toContain('## Technical Notes');
    });

    it('formats body with context only', () => {
      const body = formatIssueBody({
        title: 'Issue with Context',
        context: 'Important context here',
      });

      expect(body).toContain('## Summary');
      expect(body).toContain('## Context');
      expect(body).toContain('Important context here');
      expect(body).not.toContain('## Acceptance Criteria');
    });

    it('formats body with acceptance criteria only', () => {
      const body = formatIssueBody({
        title: 'Issue with Criteria',
        acceptanceCriteria: ['Must do X', 'Must do Y', 'Must do Z'],
      });

      expect(body).toContain('## Acceptance Criteria');
      expect(body).toContain('- [ ] Must do X');
      expect(body).toContain('- [ ] Must do Y');
      expect(body).toContain('- [ ] Must do Z');
    });

    it('handles empty acceptance criteria array', () => {
      const body = formatIssueBody({
        title: 'Issue with Empty Criteria',
        acceptanceCriteria: [],
      });

      expect(body).not.toContain('## Acceptance Criteria');
    });

    it('formats body with custom body override', () => {
      const body = formatIssueBody({
        title: 'Issue with Custom Body',
        body: 'This is my custom body content',
      });

      expect(body).toBe('This is my custom body content');
    });

    it('uses custom body over other fields when provided', () => {
      const body = formatIssueBody({
        title: 'Issue',
        body: 'Custom content',
        context: 'This should be ignored',
        acceptanceCriteria: ['Should be ignored'],
      });

      expect(body).toBe('Custom content');
      expect(body).not.toContain('## Context');
      expect(body).not.toContain('## Acceptance Criteria');
    });
  });
});
