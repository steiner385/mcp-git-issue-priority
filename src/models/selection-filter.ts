import { z } from 'zod';
import type { Issue, IssueType } from './issue.js';
import { IssueTypeSchema, getTypeLabel, getStatusLabel } from './issue.js';

export const SelectionFilterSchema = z.object({
  includeTypes: z.array(IssueTypeSchema).optional(),
  excludeTypes: z.array(IssueTypeSchema).optional(),
});

export type SelectionFilter = z.infer<typeof SelectionFilterSchema>;

export function applyFilters(issues: Issue[], filter: SelectionFilter): Issue[] {
  let filtered = issues;

  filtered = filtered.filter((issue) => {
    const status = getStatusLabel(issue);
    return status !== 'status:in-progress';
  });

  filtered = filtered.filter((issue) => !issue.assignees?.length);

  if (filter.includeTypes && filter.includeTypes.length > 0) {
    const includeSet = new Set(filter.includeTypes);
    filtered = filtered.filter((issue) => {
      const typeLabel = getTypeLabel(issue);
      if (!typeLabel) return false;
      const type = typeLabel.replace('type:', '') as IssueType;
      return includeSet.has(type);
    });
  }

  if (filter.excludeTypes && filter.excludeTypes.length > 0) {
    const excludeSet = new Set(filter.excludeTypes);
    filtered = filtered.filter((issue) => {
      const typeLabel = getTypeLabel(issue);
      if (!typeLabel) return true;
      const type = typeLabel.replace('type:', '') as IssueType;
      return !excludeSet.has(type);
    });
  }

  return filtered;
}

export function validateFilter(data: unknown): SelectionFilter | null {
  const result = SelectionFilterSchema.safeParse(data);
  return result.success ? result.data : null;
}
