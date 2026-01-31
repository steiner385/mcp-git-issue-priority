import { readFile, writeFile, unlink, readdir } from 'fs/promises';
import { join } from 'path';
import { getWorkflowDir, getConfig, ensureDirectories } from '../config/index.js';
import {
  type WorkflowState,
  type WorkflowPhase,
  type PhaseTransition,
  type SkipJustification,
  createWorkflowState,
  getWorkflowFileName,
  validateWorkflowState,
  isValidTransition,
  canSkipTo,
  getSkippedPhases,
  requiresTestsForTransition,
} from '../models/index.js';

export interface TransitionResult {
  success: boolean;
  previousPhase?: WorkflowPhase;
  currentPhase?: WorkflowPhase;
  error?: string;
  code?: string;
}

export class WorkflowService {
  private workflowDir: string;
  private sessionId: string;

  constructor(sessionId: string, workflowDir?: string) {
    this.sessionId = sessionId;
    this.workflowDir = workflowDir ?? getWorkflowDir();
  }

  private getWorkflowFilePath(owner: string, repo: string, issueNumber: number): string {
    return join(this.workflowDir, getWorkflowFileName(owner, repo, issueNumber));
  }

  async createWorkflowState(
    owner: string,
    repo: string,
    issueNumber: number,
    triggeredBy: string
  ): Promise<WorkflowState> {
    await ensureDirectories();
    const state = createWorkflowState(issueNumber, `${owner}/${repo}`, triggeredBy);
    await this.saveWorkflowState(owner, repo, issueNumber, state);
    return state;
  }

  async getWorkflowState(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<WorkflowState | null> {
    const filePath = this.getWorkflowFilePath(owner, repo, issueNumber);
    try {
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      return validateWorkflowState(data);
    } catch {
      return null;
    }
  }

  async saveWorkflowState(
    owner: string,
    repo: string,
    issueNumber: number,
    state: WorkflowState
  ): Promise<void> {
    await ensureDirectories();
    const filePath = this.getWorkflowFilePath(owner, repo, issueNumber);
    await writeFile(filePath, JSON.stringify(state, null, 2));
  }

  async deleteWorkflowState(owner: string, repo: string, issueNumber: number): Promise<void> {
    const filePath = this.getWorkflowFilePath(owner, repo, issueNumber);
    try {
      await unlink(filePath);
    } catch {
      // File doesn't exist or already deleted - ignore
    }
  }

  validatePhaseTransition(
    currentPhase: WorkflowPhase,
    targetPhase: WorkflowPhase,
    options?: { testsPassed?: boolean; skipJustification?: string }
  ): { valid: boolean; error?: string; code?: string; requiresSkipJustification?: boolean } {
    if (isValidTransition(currentPhase, targetPhase)) {
      if (requiresTestsForTransition(targetPhase)) {
        if (!options?.testsPassed && !options?.skipJustification) {
          return {
            valid: false,
            error: 'Tests must pass before creating PR',
            code: 'TESTS_REQUIRED',
          };
        }
      }
      return { valid: true };
    }

    if (canSkipTo(currentPhase, targetPhase)) {
      const skippedPhases = getSkippedPhases(currentPhase, targetPhase);
      if (skippedPhases.length > 0 && !options?.skipJustification) {
        return {
          valid: false,
          error: `Skipping phases ${skippedPhases.join(', ')} requires justification`,
          code: 'SKIP_JUSTIFICATION_REQUIRED',
          requiresSkipJustification: true,
        };
      }

      if (requiresTestsForTransition(targetPhase)) {
        if (!options?.testsPassed && !options?.skipJustification) {
          return {
            valid: false,
            error: 'Tests must pass before creating PR',
            code: 'TESTS_REQUIRED',
          };
        }
      }

      return { valid: true };
    }

    return {
      valid: false,
      error: `Cannot advance from ${currentPhase} to ${targetPhase}`,
      code: 'INVALID_PHASE_TRANSITION',
    };
  }

  async recordPhaseTransition(
    owner: string,
    repo: string,
    issueNumber: number,
    targetPhase: WorkflowPhase,
    triggeredBy: string,
    options?: { testsPassed?: boolean; skipJustification?: string }
  ): Promise<TransitionResult> {
    const state = await this.getWorkflowState(owner, repo, issueNumber);
    if (!state) {
      return {
        success: false,
        error: 'Workflow state not found',
        code: 'WORKFLOW_NOT_FOUND',
      };
    }

    const validation = this.validatePhaseTransition(state.currentPhase, targetPhase, options);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        code: validation.code,
      };
    }

    const previousPhase = state.currentPhase;

    if (options?.skipJustification) {
      const skippedPhases = getSkippedPhases(state.currentPhase, targetPhase);
      for (const skippedPhase of skippedPhases) {
        const justification: SkipJustification = {
          skippedPhase,
          justification: options.skipJustification,
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
        };
        state.skipJustifications.push(justification);
      }
    }

    const transition: PhaseTransition = {
      from: state.currentPhase,
      to: targetPhase,
      timestamp: new Date().toISOString(),
      triggeredBy,
    };

    state.phaseHistory.push(transition);
    state.currentPhase = targetPhase;

    if (options?.testsPassed !== undefined) {
      state.testsPassed = options.testsPassed;
    }

    await this.saveWorkflowState(owner, repo, issueNumber, state);

    return {
      success: true,
      previousPhase,
      currentPhase: targetPhase,
    };
  }

  async updateBranchName(
    owner: string,
    repo: string,
    issueNumber: number,
    branchName: string
  ): Promise<void> {
    const state = await this.getWorkflowState(owner, repo, issueNumber);
    if (state) {
      state.branchName = branchName;
      await this.saveWorkflowState(owner, repo, issueNumber, state);
    }
  }

  async updatePrNumber(
    owner: string,
    repo: string,
    issueNumber: number,
    prNumber: number
  ): Promise<void> {
    const state = await this.getWorkflowState(owner, repo, issueNumber);
    if (state) {
      state.prNumber = prNumber;
      await this.saveWorkflowState(owner, repo, issueNumber, state);
    }
  }

  generateBranchName(issueNumber: number, title: string): string {
    const kebabTitle = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 50)
      .replace(/-$/, '');

    return `${issueNumber}-${kebabTitle}`;
  }

  async listWorkflowStates(): Promise<WorkflowState[]> {
    await ensureDirectories();
    const states: WorkflowState[] = [];

    try {
      const files = await readdir(this.workflowDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = join(this.workflowDir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const data = JSON.parse(content);
          const state = validateWorkflowState(data);
          if (state) {
            states.push(state);
          }
        } catch {
          // Invalid or corrupted workflow file - skip
        }
      }
    } catch {
      // Directory doesn't exist or permission error - return empty array
    }

    return states;
  }
}

let globalWorkflowService: WorkflowService | null = null;

export function getWorkflowService(): WorkflowService {
  if (!globalWorkflowService) {
    const config = getConfig();
    globalWorkflowService = new WorkflowService(config.sessionId);
  }
  return globalWorkflowService;
}

export function initializeWorkflowService(sessionId: string, workflowDir?: string): WorkflowService {
  globalWorkflowService = new WorkflowService(sessionId, workflowDir);
  return globalWorkflowService;
}

export function resetWorkflowService(): void {
  globalWorkflowService = null;
}
