import { appendFile, readFile, writeFile, unlink, mkdir, rename } from 'fs/promises';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getMetricsDir } from '../config/index.js';

export type ApiCallType = 'graphql' | 'rest' | 'cache_hit';

interface ApiLogEntry {
  timestamp: string;
  type: ApiCallType;
  operation: string;
  owner?: string;
  repo?: string;
}

interface MetricsSummary {
  date: string;
  totals: { graphql: number; rest: number; cache_hit: number };
  operations: Record<string, number>;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export class MetricsService {
  private summary: MetricsSummary | null = null;
  private readonly metricsDir: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(metricsDir?: string) {
    this.metricsDir = metricsDir ?? getMetricsDir();
  }

  private logPath(date: string): string {
    return join(this.metricsDir, `api-${date}.jsonl`);
  }

  private summaryPath(date: string): string {
    return join(this.metricsDir, `summary-${date}.json`);
  }

  private async loadSummary(date: string): Promise<MetricsSummary> {
    if (this.summary && this.summary.date === date) return this.summary;

    try {
      const raw = await readFile(this.summaryPath(date), 'utf-8');
      const parsed = JSON.parse(raw) as MetricsSummary;
      if (parsed.date === date) {
        this.summary = parsed;
        return this.summary;
      }
    } catch { /* no file yet or corrupt — start fresh */ }

    this.summary = { date, totals: { graphql: 0, rest: 0, cache_hit: 0 }, operations: {} };
    return this.summary;
  }

  private async persistSummary(summary: MetricsSummary): Promise<void> {
    const filePath = this.summaryPath(summary.date);
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(summary, null, 2), 'utf-8');
      await rename(tmp, filePath);
    } catch (err) {
      try { await unlink(tmp); } catch { /* ignore cleanup failure */ }
      throw err;
    }
  }

  private async doRecord(
    type: ApiCallType,
    operation: string,
    owner?: string,
    repo?: string
  ): Promise<void> {
    const date = todayKey();
    await mkdir(this.metricsDir, { recursive: true });

    const entry: ApiLogEntry = {
      timestamp: new Date().toISOString(),
      type,
      operation,
      ...(owner && { owner }),
      ...(repo && { repo }),
    };
    await appendFile(this.logPath(date), JSON.stringify(entry) + '\n', 'utf-8');

    const summary = await this.loadSummary(date);
    summary.totals[type]++;
    summary.operations[operation] = (summary.operations[operation] ?? 0) + 1;
    await this.persistSummary(summary);
  }

  record(type: ApiCallType, operation: string, owner?: string, repo?: string): void {
    this.queue = this.queue
      .then(() => this.doRecord(type, operation, owner, repo))
      .catch((err) => { console.error(`[metrics] record failed: ${(err as Error).message}`); });
  }

  async getSummary(date?: string): Promise<MetricsSummary> {
    const d = date ?? todayKey();
    await mkdir(this.metricsDir, { recursive: true });
    return this.loadSummary(d);
  }

  async getAggregatedSummary(dates: string[]): Promise<MetricsSummary> {
    const merged: MetricsSummary = {
      date: dates[0] ?? todayKey(),
      totals: { graphql: 0, rest: 0, cache_hit: 0 },
      operations: {},
    };
    for (const date of dates) {
      const s = await this.loadSummary(date);
      merged.totals.graphql += s.totals.graphql;
      merged.totals.rest += s.totals.rest;
      merged.totals.cache_hit += s.totals.cache_hit;
      for (const [op, count] of Object.entries(s.operations)) {
        merged.operations[op] = (merged.operations[op] ?? 0) + count;
      }
    }
    return merged;
  }

  async getLog(
    dates?: string | string[],
    filter?: { type?: ApiCallType; owner?: string; repo?: string },
    limit = 500
  ): Promise<ApiLogEntry[]> {
    const dateList = Array.isArray(dates)
      ? dates
      : [dates ?? todayKey()];

    const all: ApiLogEntry[] = [];
    for (const d of dateList) {
      const entries = await this.readLogFile(d, filter);
      all.push(...entries);
    }

    all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return all.slice(-limit);
  }

  private async readLogFile(
    date: string,
    filter?: { type?: ApiCallType; owner?: string; repo?: string }
  ): Promise<ApiLogEntry[]> {
    const entries: ApiLogEntry[] = [];
    try {
      const rl = createInterface({
        input: createReadStream(this.logPath(date), 'utf-8'),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as ApiLogEntry;
          if (filter?.type && entry.type !== filter.type) continue;
          if (filter?.owner && entry.owner !== filter.owner) continue;
          if (filter?.repo && entry.repo !== filter.repo) continue;
          entries.push(entry);
        } catch { /* skip malformed lines */ }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[metrics] readLogFile(${date}) failed: ${(err as Error).message}`);
      }
    }
    return entries;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}

let globalMetricsService: MetricsService | null = null;

export function getMetricsService(): MetricsService {
  if (!globalMetricsService) {
    globalMetricsService = new MetricsService();
  }
  return globalMetricsService;
}

export function initializeMetricsService(metricsDir?: string): MetricsService {
  globalMetricsService = new MetricsService(metricsDir);
  return globalMetricsService;
}

export function resetMetricsService(): void {
  globalMetricsService = null;
}
