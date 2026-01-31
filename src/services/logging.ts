import { appendFile, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { getLogsDir, ensureDirectories } from '../config/index.js';
import {
  type AuditLogEntry,
  type AuditLogLevel,
  type AuditLogOutcome,
  type WorkflowPhase,
  createAuditLogEntry,
  serializeLogEntry,
  getLogFileName,
} from '../models/index.js';

export class AuditLogger {
  private logsDir: string;
  private sessionId: string;

  constructor(sessionId: string, logsDir?: string) {
    this.sessionId = sessionId;
    this.logsDir = logsDir ?? getLogsDir();
  }

  async log(entry: AuditLogEntry): Promise<void> {
    await ensureDirectories();
    const fileName = getLogFileName(new Date(entry.timestamp));
    const filePath = join(this.logsDir, fileName);
    const line = serializeLogEntry(entry) + '\n';
    await appendFile(filePath, line);
  }

  async logToolCall(
    tool: string,
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
  ): Promise<void> {
    const entry = createAuditLogEntry(tool, this.sessionId, outcome, options);
    await this.log(entry);
  }

  async info(
    tool: string,
    options?: {
      repoFullName?: string;
      issueNumber?: number;
      phase?: WorkflowPhase;
      duration?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    await this.logToolCall(tool, 'success', { level: 'info', ...options });
  }

  async warn(
    tool: string,
    message: string,
    options?: {
      repoFullName?: string;
      issueNumber?: number;
      phase?: WorkflowPhase;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    await this.logToolCall(tool, 'skipped', {
      level: 'warn',
      error: message,
      ...options,
    });
  }

  async error(
    tool: string,
    error: string | Error,
    options?: {
      repoFullName?: string;
      issueNumber?: number;
      phase?: WorkflowPhase;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : error;
    await this.logToolCall(tool, 'failure', {
      level: 'error',
      error: errorMessage,
      ...options,
    });
  }

  async cleanupOldLogs(retentionDays: number = 30): Promise<number> {
    await ensureDirectories();
    const files = await readdir(this.logsDir);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    let deletedCount = 0;

    for (const file of files) {
      if (!file.startsWith('audit-') || !file.endsWith('.jsonl')) continue;

      const dateMatch = file.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!dateMatch) continue;

      const fileDate = new Date(dateMatch[1]);
      if (fileDate < cutoffDate) {
        const filePath = join(this.logsDir, file);
        await unlink(filePath);
        deletedCount++;
      }
    }

    return deletedCount;
  }
}

let globalLogger: AuditLogger | null = null;

export function getLogger(sessionId?: string): AuditLogger {
  if (!globalLogger && !sessionId) {
    throw new Error('Logger not initialized. Call initializeLogger first.');
  }
  if (!globalLogger && sessionId) {
    globalLogger = new AuditLogger(sessionId);
  }
  return globalLogger!;
}

export function initializeLogger(sessionId: string, logsDir?: string): AuditLogger {
  globalLogger = new AuditLogger(sessionId, logsDir);
  return globalLogger;
}

export function resetLogger(): void {
  globalLogger = null;
}
