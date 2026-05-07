import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { MetricsService } from '../../src/services/metrics.js';

describe('MetricsService', () => {
  let tmpDir: string;
  let metrics: MetricsService;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `metrics-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    metrics = new MetricsService(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('record + getSummary', () => {
    it('initializes totals to zero when no file exists', async () => {
      const summary = await metrics.getSummary();

      expect(summary.totals.graphql).toBe(0);
      expect(summary.totals.rest).toBe(0);
      expect(summary.totals.cache_hit).toBe(0);
    });

    it('increments the correct total for each type', async () => {
      metrics.record('graphql', 'issues_delta_gql');
      metrics.record('graphql', 'issues_delta_gql');
      metrics.record('rest', 'issue_create_rest');
      metrics.record('cache_hit', 'issues_cache_hit');

      await metrics.flush();

      const fresh = new MetricsService(tmpDir);
      const summary = await fresh.getSummary();

      expect(summary.totals.graphql).toBe(2);
      expect(summary.totals.rest).toBe(1);
      expect(summary.totals.cache_hit).toBe(1);
    });

    it('tracks per-operation counts', async () => {
      metrics.record('graphql', 'issues_delta_gql', 'owner', 'repo');
      metrics.record('graphql', 'pr_status_gql', 'owner', 'repo');
      metrics.record('graphql', 'issues_delta_gql', 'owner', 'repo');

      await metrics.flush();

      const fresh = new MetricsService(tmpDir);
      const summary = await fresh.getSummary();

      expect(summary.operations['issues_delta_gql']).toBe(2);
      expect(summary.operations['pr_status_gql']).toBe(1);
    });

    it('includes the correct date in the summary', async () => {
      const summary = await metrics.getSummary();
      const today = new Date().toISOString().slice(0, 10);

      expect(summary.date).toBe(today);
    });
  });

  describe('getLog', () => {
    it('returns empty array when no log file exists', async () => {
      const log = await metrics.getLog();

      expect(log).toEqual([]);
    });

    it('returns log entries after records are written', async () => {
      metrics.record('graphql', 'issues_delta_gql', 'owner', 'repo');
      metrics.record('rest', 'issue_create_rest', 'owner', 'repo');

      await metrics.flush();

      const fresh = new MetricsService(tmpDir);
      const log = await fresh.getLog();

      expect(log).toHaveLength(2);
      expect(log[0].type).toBe('graphql');
      expect(log[0].operation).toBe('issues_delta_gql');
      expect(log[1].type).toBe('rest');
    });

    it('filters by type', async () => {
      metrics.record('graphql', 'issues_delta_gql', 'owner', 'repo');
      metrics.record('rest', 'issue_create_rest', 'owner', 'repo');
      metrics.record('cache_hit', 'issues_cache_hit', 'owner', 'repo');

      await metrics.flush();

      const fresh = new MetricsService(tmpDir);
      const log = await fresh.getLog(undefined, { type: 'graphql' });

      expect(log).toHaveLength(1);
      expect(log[0].type).toBe('graphql');
    });

    it('filters by owner', async () => {
      metrics.record('graphql', 'issues_delta_gql', 'owner-a', 'repo');
      metrics.record('graphql', 'issues_delta_gql', 'owner-b', 'repo');

      await metrics.flush();

      const fresh = new MetricsService(tmpDir);
      const log = await fresh.getLog(undefined, { owner: 'owner-a' });

      expect(log).toHaveLength(1);
      expect(log[0].owner).toBe('owner-a');
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        metrics.record('rest', 'issue_get_rest', 'owner', 'repo');
      }

      await metrics.flush();

      const fresh = new MetricsService(tmpDir);
      const log = await fresh.getLog(undefined, undefined, 3);

      expect(log).toHaveLength(3);
    });
  });
});
