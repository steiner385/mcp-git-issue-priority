import { z } from 'zod';
import type { Issue, PriorityLabel } from './issue.js';
import { getPriorityLabel, hasLabel } from './issue.js';

export const PriorityScoreSchema = z.object({
  issueNumber: z.number().int().positive(),
  basePoints: z.number().int().nonnegative(),
  ageBonus: z.number().int().nonnegative(),
  blockingMultiplier: z.number().positive(),
  totalScore: z.number().nonnegative(),
});

export type PriorityScore = z.infer<typeof PriorityScoreSchema>;

export const PRIORITY_BASE_POINTS: Record<PriorityLabel, number> = {
  'priority:critical': 1000,
  'priority:high': 100,
  'priority:medium': 10,
  'priority:low': 1,
};

export const MAX_AGE_BONUS = 30;
export const BLOCKING_MULTIPLIER = 1.5;

export function calculateAgeInDays(createdAt: string): number {
  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

export function hasBlockingRelationship(issue: Issue): boolean {
  return hasLabel(issue, 'blocking') || hasLabel(issue, 'blocker');
}

export function calculatePriorityScore(issue: Issue): PriorityScore {
  const priorityLabel = getPriorityLabel(issue);
  const basePoints = priorityLabel ? PRIORITY_BASE_POINTS[priorityLabel] : 0;

  const ageInDays = calculateAgeInDays(issue.created_at);
  const ageBonus = Math.min(ageInDays, MAX_AGE_BONUS);

  const blocksOthers = hasBlockingRelationship(issue);
  const blockingMultiplier = blocksOthers ? BLOCKING_MULTIPLIER : 1.0;

  const totalScore = (basePoints + ageBonus) * blockingMultiplier;

  return {
    issueNumber: issue.number,
    basePoints,
    ageBonus,
    blockingMultiplier,
    totalScore,
  };
}

export function comparePriorityScores(a: PriorityScore, b: PriorityScore): number {
  if (a.totalScore !== b.totalScore) {
    return b.totalScore - a.totalScore;
  }
  return a.issueNumber - b.issueNumber;
}

export function sortByPriority(issues: Issue[]): Issue[] {
  const scored = issues.map((issue) => ({
    issue,
    score: calculatePriorityScore(issue),
  }));

  scored.sort((a, b) => comparePriorityScores(a.score, b.score));

  return scored.map(({ issue }) => issue);
}
