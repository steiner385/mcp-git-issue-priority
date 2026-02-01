import { z } from 'zod';

export const CheckStatusSchema = z.object({
  name: z.string(),
  status: z.enum(['queued', 'in_progress', 'success', 'failure', 'neutral', 'skipped']),
});

export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CiStatusSchema = z.object({
  status: z.enum(['pending', 'passing', 'failing', 'none']),
  checks: z.array(CheckStatusSchema),
});

export type CiStatus = z.infer<typeof CiStatusSchema>;

export const ReviewStatusSchema = z.object({
  approved: z.boolean(),
  changesRequested: z.boolean(),
  reviewers: z.array(z.string()),
});

export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const AutoMergeStatusSchema = z.object({
  enabled: z.boolean(),
});

export type AutoMergeStatus = z.infer<typeof AutoMergeStatusSchema>;

export const PrStatusSchema = z.object({
  prNumber: z.number().int().positive(),
  state: z.enum(['open', 'closed', 'merged']),
  mergeable: z.boolean().nullable(),
  ci: CiStatusSchema,
  reviews: ReviewStatusSchema,
  autoMerge: AutoMergeStatusSchema,
});

export type PrStatus = z.infer<typeof PrStatusSchema>;

export function validatePrStatus(data: unknown): PrStatus | null {
  const result = PrStatusSchema.safeParse(data);
  return result.success ? result.data : null;
}

export function isPrReadyToMerge(status: PrStatus): boolean {
  return (
    status.state === 'merged' ||
    (status.ci.status === 'passing' &&
      status.reviews.approved &&
      !status.reviews.changesRequested)
  );
}
