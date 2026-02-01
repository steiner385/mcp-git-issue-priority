import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getWorkflowService } from '../services/workflow.js';
import { getLogger } from '../services/logging.js';
import { type WorkflowState, type WorkflowPhase, PHASE_ORDER } from '../models/workflow-state.js';

function parseRepository(repository?: string): { owner: string; repo: string } | null {
  if (!repository) return null;
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function calculatePhaseTime(state: WorkflowState, phase: WorkflowPhase): number {
  const history = state.phaseHistory;
  let totalTime = 0;

  for (let i = 0; i < history.length; i++) {
    const transition = history[i];
    if (transition.to === phase) {
      // Find when this phase ended (next transition)
      const nextTransition = history[i + 1];
      if (nextTransition) {
        const startTime = new Date(transition.timestamp).getTime();
        const endTime = new Date(nextTransition.timestamp).getTime();
        totalTime += endTime - startTime;
      } else if (state.currentPhase === phase) {
        // Currently in this phase
        const startTime = new Date(transition.timestamp).getTime();
        totalTime += Date.now() - startTime;
      }
    }
  }

  return totalTime;
}

function calculateCycleTime(state: WorkflowState): number | null {
  if (state.currentPhase !== 'merged' && state.currentPhase !== 'abandoned') {
    return null;
  }

  const history = state.phaseHistory;
  if (history.length < 2) return null;

  const startTime = new Date(history[0].timestamp).getTime();
  const endTime = new Date(history[history.length - 1].timestamp).getTime();

  return endTime - startTime;
}

function getPeriodCutoff(period: string): number {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  switch (period) {
    case '7d':
      return now - 7 * day;
    case '30d':
      return now - 30 * day;
    case '90d':
      return now - 90 * day;
    case 'all':
      return 0;
    default:
      return now - 30 * day;
  }
}

function getWorkflowStartTime(state: WorkflowState): number {
  if (state.phaseHistory.length === 0) return 0;
  return new Date(state.phaseHistory[0].timestamp).getTime();
}

interface PhaseBreakdown {
  phase: string;
  avgTimeMs: number;
  avgTimeFormatted: string;
  medianTimeMs: number;
  medianTimeFormatted: string;
  count: number;
}

interface AgingInfo {
  issueNumber: number;
  currentPhase: string;
  ageMs: number;
  ageFormatted: string;
}

interface WorkflowAnalytics {
  period: string;
  repository: string;
  summary: {
    total: number;
    completed: number;
    abandoned: number;
    inProgress: number;
  };
  cycleTime: {
    avgMs: number;
    avgFormatted: string;
    medianMs: number;
    medianFormatted: string;
    p90Ms: number;
    p90Formatted: string;
    count: number;
  };
  phaseBreakdown: PhaseBreakdown[];
  aging: {
    oldest: AgingInfo | null;
    staleCount: number;
    staleIssues: AgingInfo[];
  };
}

export function registerGetWorkflowAnalyticsTool(server: McpServer) {
  server.tool(
    'get_workflow_analytics',
    'Get time-based analytics for workflow phases including cycle times, phase breakdowns, and aging metrics',
    {
      repository: z
        .string()
        .regex(/^[^/]+\/[^/]+$/)
        .describe("Repository in 'owner/repo' format"),
      period: z
        .enum(['7d', '30d', '90d', 'all'])
        .default('30d')
        .describe('Time period for analytics (default: 30d)'),
    },
    async (args) => {
      const startTime = Date.now();
      const logger = getLogger();
      const workflow = getWorkflowService();

      const parsed = parseRepository(args.repository);
      if (!parsed) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Repository is required in owner/repo format',
                code: 'REPO_REQUIRED',
              }),
            },
          ],
          isError: true,
        };
      }

      const { owner, repo } = parsed;
      const repoFullName = `${owner}/${repo}`;
      const period = args.period ?? '30d';

      try {
        const allStates = await workflow.listWorkflowStates();
        const cutoffTime = getPeriodCutoff(period);

        // Filter by repository and period
        const filteredStates = allStates.filter((state) => {
          if (state.repoFullName !== repoFullName) return false;
          const startTime = getWorkflowStartTime(state);
          return startTime >= cutoffTime;
        });

        // Separate into categories
        const completed = filteredStates.filter((s) => s.currentPhase === 'merged');
        const abandoned = filteredStates.filter((s) => s.currentPhase === 'abandoned');
        const inProgress = filteredStates.filter(
          (s) => s.currentPhase !== 'merged' && s.currentPhase !== 'abandoned'
        );

        // Calculate cycle times for completed issues
        const cycleTimes = completed
          .map((s) => calculateCycleTime(s))
          .filter((t): t is number => t !== null);

        // Calculate phase breakdown
        const phaseTimesMap: Record<string, number[]> = {};
        const phasesToAnalyze = PHASE_ORDER.filter(
          (p) => p !== 'merged' && p !== 'abandoned' && p !== 'selection'
        );

        for (const phase of phasesToAnalyze) {
          phaseTimesMap[phase] = [];
        }

        for (const state of completed) {
          for (const phase of phasesToAnalyze) {
            const time = calculatePhaseTime(state, phase);
            if (time > 0) {
              phaseTimesMap[phase].push(time);
            }
          }
        }

        const phaseBreakdown: PhaseBreakdown[] = phasesToAnalyze
          .map((phase) => {
            const times = phaseTimesMap[phase];
            const avgTime = average(times);
            const medianTime = median(times);
            return {
              phase,
              avgTimeMs: Math.round(avgTime),
              avgTimeFormatted: formatDuration(avgTime),
              medianTimeMs: Math.round(medianTime),
              medianTimeFormatted: formatDuration(medianTime),
              count: times.length,
            };
          })
          .filter((p) => p.count > 0);

        // Calculate aging for in-progress issues
        const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
        const now = Date.now();

        const agingInfos: AgingInfo[] = inProgress.map((state) => {
          const startTime = getWorkflowStartTime(state);
          const ageMs = now - startTime;
          return {
            issueNumber: state.issueNumber,
            currentPhase: state.currentPhase,
            ageMs,
            ageFormatted: formatDuration(ageMs),
          };
        });

        // Sort by age descending to find oldest
        agingInfos.sort((a, b) => b.ageMs - a.ageMs);

        const staleIssues = agingInfos.filter((a) => a.ageMs > STALE_THRESHOLD_MS);

        const analytics: WorkflowAnalytics = {
          period,
          repository: repoFullName,
          summary: {
            total: filteredStates.length,
            completed: completed.length,
            abandoned: abandoned.length,
            inProgress: inProgress.length,
          },
          cycleTime: {
            avgMs: Math.round(average(cycleTimes)),
            avgFormatted: formatDuration(average(cycleTimes)),
            medianMs: Math.round(median(cycleTimes)),
            medianFormatted: formatDuration(median(cycleTimes)),
            p90Ms: Math.round(percentile(cycleTimes, 90)),
            p90Formatted: formatDuration(percentile(cycleTimes, 90)),
            count: cycleTimes.length,
          },
          phaseBreakdown,
          aging: {
            oldest: agingInfos.length > 0 ? agingInfos[0] : null,
            staleCount: staleIssues.length,
            staleIssues: staleIssues.slice(0, 10), // Limit to top 10 stale issues
          },
        };

        const duration = Date.now() - startTime;
        await logger.info('get_workflow_analytics', {
          repoFullName,
          duration,
          metadata: {
            period,
            total: filteredStates.length,
            completed: completed.length,
            inProgress: inProgress.length,
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                analytics,
              }),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logger.error('get_workflow_analytics', errorMessage, {
          repoFullName,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: `Error calculating analytics: ${errorMessage}`,
                code: 'INTERNAL_ERROR',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
