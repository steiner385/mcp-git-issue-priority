import type { Issue } from '../models/index.js';
import {
  type PriorityScore,
  type SelectionFilter,
  calculatePriorityScore,
  comparePriorityScores,
  sortByPriority,
  applyFilters,
  calculateAgeInDays,
} from '../models/index.js';

export interface ScoredIssue {
  issue: Issue;
  score: PriorityScore;
  ageInDays: number;
  blockedByIssue?: number | null;
}

export interface DependencyInfo {
  issueNumber: number;
  blockedByIssue: number | null;
}

export function scoreIssues(issues: Issue[]): ScoredIssue[] {
  return issues.map((issue) => ({
    issue,
    score: calculatePriorityScore(issue),
    ageInDays: calculateAgeInDays(issue.created_at),
  }));
}

export function scoreIssuesWithDependencies(
  issues: Issue[],
  dependencies: Map<number, number | null>
): ScoredIssue[] {
  return issues.map((issue) => {
    const blockedByIssue = dependencies.get(issue.number) ?? null;
    return {
      issue,
      score: calculatePriorityScore(issue, { blockedByIssue }),
      ageInDays: calculateAgeInDays(issue.created_at),
      blockedByIssue,
    };
  });
}

export function filterAndScoreIssues(issues: Issue[], filter: SelectionFilter): ScoredIssue[] {
  const filtered = applyFilters(issues, filter);
  const scored = scoreIssues(filtered);
  scored.sort((a, b) => comparePriorityScores(a.score, b.score));
  return scored;
}

export function getNextPriorityIssue(
  issues: Issue[],
  filter: SelectionFilter,
  excludeIssueNumbers: number[] = []
): ScoredIssue | null {
  const excludeSet = new Set(excludeIssueNumbers);
  const scored = filterAndScoreIssues(issues, filter);
  const available = scored.filter((s) => !excludeSet.has(s.issue.number));
  return available.length > 0 ? available[0] : null;
}

export {
  calculatePriorityScore,
  comparePriorityScores,
  sortByPriority,
  applyFilters,
  calculateAgeInDays,
};
