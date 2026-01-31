import { z } from 'zod';
import type { WorkflowPhase } from './workflow-state.js';
import { WorkflowPhaseSchema } from './workflow-state.js';

export const AuditLogLevelSchema = z.enum(['info', 'warn', 'error']);
export type AuditLogLevel = z.infer<typeof AuditLogLevelSchema>;

export const AuditLogOutcomeSchema = z.enum(['success', 'failure', 'skipped']);
export type AuditLogOutcome = z.infer<typeof AuditLogOutcomeSchema>;

export const AuditLogEntrySchema = z.object({
  timestamp: z.string().datetime(),
  level: AuditLogLevelSchema,
  tool: z.string(),
  sessionId: z.string().uuid(),
  repoFullName: z.string().optional(),
  issueNumber: z.number().int().positive().optional(),
  phase: WorkflowPhaseSchema.optional(),
  duration: z.number().int().nonnegative().optional(),
  outcome: AuditLogOutcomeSchema,
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export function createAuditLogEntry(
  tool: string,
  sessionId: string,
  outcome: AuditLogOutcome,
  options?: {
    level?: AuditLogLevel;
    repoFullName?: string;
    issueNumber?: number;
    phase?: WorkflowPhase;
    duration?: number;
    error?: string;
    metadata?: Record<string, unknown>;
  }
): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    level: options?.level ?? (outcome === 'failure' ? 'error' : 'info'),
    tool,
    sessionId,
    outcome,
    ...(options?.repoFullName && { repoFullName: options.repoFullName }),
    ...(options?.issueNumber && { issueNumber: options.issueNumber }),
    ...(options?.phase && { phase: options.phase }),
    ...(options?.duration !== undefined && { duration: options.duration }),
    ...(options?.error && { error: options.error }),
    ...(options?.metadata && { metadata: options.metadata }),
  };
}

export function serializeLogEntry(entry: AuditLogEntry): string {
  return JSON.stringify(entry);
}

export function parseLogEntry(line: string): AuditLogEntry | null {
  try {
    const data = JSON.parse(line);
    const result = AuditLogEntrySchema.safeParse(data);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function getLogFileName(date: Date = new Date()): string {
  const dateStr = date.toISOString().split('T')[0];
  return `audit-${dateStr}.jsonl`;
}
