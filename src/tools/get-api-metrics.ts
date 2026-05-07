import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMetricsService } from '../services/metrics.js';

function dateRange(days: number): string[] {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export function registerGetApiMetricsTool(server: McpServer) {
  server.tool(
    'get_api_metrics',
    'Query GitHub API call counts and cache hit metrics. Returns a summary of REST calls, GraphQL calls, and cache hits broken down by operation, plus optional raw log entries. Use "days" for a rolling window or "date" for a specific day.',
    {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Specific date in YYYY-MM-DD format. Mutually exclusive with 'days'."),
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe('Rolling window: aggregate the last N days (e.g. 7 for a week). Mutually exclusive with "date". Default: 1 (today only).'),
      filter_type: z
        .enum(['graphql', 'rest', 'cache_hit'])
        .optional()
        .describe('Filter log entries by call type'),
      filter_repo: z
        .string()
        .optional()
        .describe("Filter log entries by repository (owner/repo format)"),
      include_log: z
        .boolean()
        .default(false)
        .describe('Include raw per-call log entries (default: false)'),
      log_limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe('Max log entries to return when include_log is true (default: 100)'),
    },
    async (args) => {
      const metrics = getMetricsService();

      try {
        const dates: string[] = args.date
          ? [args.date]
          : dateRange(args.days ?? 1);

        const summary = dates.length === 1
          ? await metrics.getSummary(dates[0])
          : await metrics.getAggregatedSummary(dates);

        const total = summary.totals.graphql + summary.totals.rest + summary.totals.cache_hit;
        const cacheHitRate = total > 0
          ? Math.round((summary.totals.cache_hit / total) * 100)
          : 0;
        const externalCalls = summary.totals.graphql + summary.totals.rest;

        const result: Record<string, unknown> = {
          success: true,
          period: dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`,
          days: dates.length,
          totals: {
            graphql: summary.totals.graphql,
            rest: summary.totals.rest,
            cache_hit: summary.totals.cache_hit,
            external_calls: externalCalls,
            cache_hit_rate_pct: cacheHitRate,
          },
          operations: summary.operations,
        };

        if (args.include_log) {
          const [owner, repo] = args.filter_repo
            ? args.filter_repo.split('/')
            : [undefined, undefined];

          const logEntries = await metrics.getLog(
            dates,
            { type: args.filter_type, owner, repo },
            args.log_limit ?? 100
          );
          result.log = logEntries;
          result.log_count = logEntries.length;
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: `Error reading metrics: ${errorMessage}`,
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
