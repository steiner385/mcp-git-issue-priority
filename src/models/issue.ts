import { z } from 'zod';

export const LabelSchema = z.object({
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});

export type Label = z.infer<typeof LabelSchema>;

export const AssigneeSchema = z.object({
  login: z.string(),
});

export type Assignee = z.infer<typeof AssigneeSchema>;

export const RepositoryContextSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  full_name: z.string(),
});

export type RepositoryContext = z.infer<typeof RepositoryContextSchema>;

export const IssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  created_at: z.string(),
  updated_at: z.string(),
  labels: z.array(LabelSchema),
  assignees: z.array(AssigneeSchema),
  html_url: z.string().url(),
  repository: RepositoryContextSchema,
});

export type Issue = z.infer<typeof IssueSchema>;

export const PriorityLabelSchema = z.enum([
  'priority:critical',
  'priority:high',
  'priority:medium',
  'priority:low',
]);

export type PriorityLabel = z.infer<typeof PriorityLabelSchema>;

export const TypeLabelSchema = z.enum(['type:bug', 'type:feature', 'type:chore', 'type:docs']);

export type TypeLabel = z.infer<typeof TypeLabelSchema>;

export const StatusLabelSchema = z.enum([
  'status:backlog',
  'status:in-progress',
  'status:in-review',
  'status:blocked',
]);

export type StatusLabel = z.infer<typeof StatusLabelSchema>;

export const IssueTypeSchema = z.enum(['bug', 'feature', 'chore', 'docs']);
export type IssueType = z.infer<typeof IssueTypeSchema>;

export const IssuePrioritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;

export function getPriorityLabel(issue: Issue): PriorityLabel | null {
  const priorityLabel = issue.labels.find((l) => l.name.startsWith('priority:'));
  if (!priorityLabel) return null;
  const result = PriorityLabelSchema.safeParse(priorityLabel.name);
  return result.success ? result.data : null;
}

export function getTypeLabel(issue: Issue): TypeLabel | null {
  const typeLabel = issue.labels.find((l) => l.name.startsWith('type:'));
  if (!typeLabel) return null;
  const result = TypeLabelSchema.safeParse(typeLabel.name);
  return result.success ? result.data : null;
}

export function getStatusLabel(issue: Issue): StatusLabel | null {
  const statusLabel = issue.labels.find((l) => l.name.startsWith('status:'));
  if (!statusLabel) return null;
  const result = StatusLabelSchema.safeParse(statusLabel.name);
  return result.success ? result.data : null;
}

export function hasLabel(issue: Issue, labelName: string): boolean {
  return issue.labels.some((l) => l.name === labelName);
}

export const LABEL_DEFINITIONS = {
  priority: {
    'priority:critical': { color: 'b60205', description: 'Production down, security vulnerability' },
    'priority:high': { color: 'd93f0b', description: 'Major feature blocked, significant impact' },
    'priority:medium': { color: 'fbca04', description: 'Normal feature work, non-blocking' },
    'priority:low': { color: '0e8a16', description: 'Nice-to-have, minor improvements' },
  },
  type: {
    'type:bug': { color: 'd73a4a', description: 'Defect in existing functionality' },
    'type:feature': { color: 'a2eeef', description: 'New capability or enhancement' },
    'type:chore': { color: 'fef2c0', description: 'Maintenance, refactoring, dependencies' },
    'type:docs': { color: '0075ca', description: 'Documentation only changes' },
  },
  status: {
    'status:backlog': { color: 'cfd3d7', description: 'Not yet started' },
    'status:in-progress': { color: '0e8a16', description: 'Actively being worked' },
    'status:in-review': { color: 'fbca04', description: 'PR open, awaiting review' },
    'status:blocked': { color: 'b60205', description: 'Cannot proceed, requires input' },
  },
} as const;
