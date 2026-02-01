import { z } from 'zod';

export const CompletedIssueSchema = z.object({
  issue: z.number().int().positive(),
  pr: z.number().int().positive(),
  startedAt: z.string().datetime(),
  mergedAt: z.string().datetime(),
});

export type CompletedIssue = z.infer<typeof CompletedIssueSchema>;

export const BatchStateSchema = z.object({
  batchId: z.string().uuid(),
  repository: z.string(),
  totalCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  currentIssue: z.number().int().positive().nullable(),
  currentPr: z.number().int().positive().nullable(),
  queue: z.array(z.number().int().positive()),
  completed: z.array(CompletedIssueSchema),
  startedAt: z.string().datetime(),
  status: z.enum(['in_progress', 'completed', 'timeout', 'abandoned']),
});

export type BatchState = z.infer<typeof BatchStateSchema>;

export function createBatchState(
  repository: string,
  totalCount: number,
  queue: number[]
): BatchState {
  return {
    batchId: crypto.randomUUID(),
    repository,
    totalCount,
    completedCount: 0,
    currentIssue: null,
    currentPr: null,
    queue,
    completed: [],
    startedAt: new Date().toISOString(),
    status: 'in_progress',
  };
}

export function validateBatchState(data: unknown): BatchState | null {
  const result = BatchStateSchema.safeParse(data);
  return result.success ? result.data : null;
}
