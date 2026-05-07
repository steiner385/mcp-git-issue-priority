import { MetricsService } from '../../src/services/metrics.js';

export function makeNullMetrics(): MetricsService {
  return {
    record: () => { /* no-op */ },
    getSummary: async () => ({
      date: new Date().toISOString().slice(0, 10),
      totals: { graphql: 0, rest: 0, cache_hit: 0 },
      operations: {},
    }),
    getAggregatedSummary: async () => ({
      date: new Date().toISOString().slice(0, 10),
      totals: { graphql: 0, rest: 0, cache_hit: 0 },
      operations: {},
    }),
    getLog: async () => [],
    flush: async () => {},
  } as unknown as MetricsService;
}
