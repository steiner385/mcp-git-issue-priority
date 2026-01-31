import { z } from 'zod';

export const WorkflowPhaseSchema = z.enum([
  'selection',
  'research',
  'branch',
  'implementation',
  'testing',
  'commit',
  'pr',
  'review',
  'merged',
  'abandoned',
]);

export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;

export const PhaseTransitionSchema = z.object({
  from: WorkflowPhaseSchema,
  to: WorkflowPhaseSchema,
  timestamp: z.string().datetime(),
  triggeredBy: z.string(),
});

export type PhaseTransition = z.infer<typeof PhaseTransitionSchema>;

export const SkipJustificationSchema = z.object({
  skippedPhase: WorkflowPhaseSchema,
  justification: z.string(),
  timestamp: z.string().datetime(),
  sessionId: z.string().uuid(),
});

export type SkipJustification = z.infer<typeof SkipJustificationSchema>;

export const WorkflowStateSchema = z.object({
  issueNumber: z.number().int().positive(),
  repoFullName: z.string(),
  currentPhase: WorkflowPhaseSchema,
  phaseHistory: z.array(PhaseTransitionSchema),
  skipJustifications: z.array(SkipJustificationSchema),
  branchName: z.string().nullable(),
  testsPassed: z.boolean().nullable(),
  prNumber: z.number().int().positive().nullable(),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export function createWorkflowState(
  issueNumber: number,
  repoFullName: string,
  triggeredBy: string
): WorkflowState {
  const now = new Date().toISOString();
  return {
    issueNumber,
    repoFullName,
    currentPhase: 'selection',
    phaseHistory: [
      {
        from: 'selection',
        to: 'selection',
        timestamp: now,
        triggeredBy,
      },
    ],
    skipJustifications: [],
    branchName: null,
    testsPassed: null,
    prNumber: null,
  };
}

export const PHASE_ORDER: WorkflowPhase[] = [
  'selection',
  'research',
  'branch',
  'implementation',
  'testing',
  'commit',
  'pr',
  'review',
  'merged',
];

export const VALID_TRANSITIONS: Record<WorkflowPhase, WorkflowPhase[]> = {
  selection: ['research', 'abandoned'],
  research: ['branch', 'abandoned'],
  branch: ['implementation', 'abandoned'],
  implementation: ['testing', 'abandoned'],
  testing: ['commit', 'abandoned'],
  commit: ['pr', 'abandoned'],
  pr: ['review', 'abandoned'],
  review: ['merged', 'abandoned'],
  merged: [],
  abandoned: [],
};

export function isValidTransition(from: WorkflowPhase, to: WorkflowPhase): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function canSkipTo(from: WorkflowPhase, to: WorkflowPhase): boolean {
  if (to === 'abandoned') return true;
  const fromIndex = PHASE_ORDER.indexOf(from);
  const toIndex = PHASE_ORDER.indexOf(to);
  return toIndex > fromIndex;
}

export function getSkippedPhases(from: WorkflowPhase, to: WorkflowPhase): WorkflowPhase[] {
  const fromIndex = PHASE_ORDER.indexOf(from);
  const toIndex = PHASE_ORDER.indexOf(to);
  if (toIndex <= fromIndex + 1) return [];
  return PHASE_ORDER.slice(fromIndex + 1, toIndex);
}

export function requiresTestsForTransition(to: WorkflowPhase): boolean {
  return to === 'commit' || to === 'pr';
}

export function getWorkflowFileName(owner: string, repo: string, issueNumber: number): string {
  return `${owner}_${repo}_${issueNumber}.json`;
}

export function validateWorkflowState(data: unknown): WorkflowState | null {
  const result = WorkflowStateSchema.safeParse(data);
  return result.success ? result.data : null;
}
