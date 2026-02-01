import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRepository } from '../../src/utils/repository.js';
import { setConfig, resetConfig, createConfig } from '../../src/config/index.js';

describe('resolveRepository', () => {
  beforeEach(() => {
    // Reset config and env vars before each test
    resetConfig();
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_OWNER;
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    resetConfig();
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_OWNER;
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
  });

  describe('with explicit argument', () => {
    it('parses valid owner/repo format', () => {
      // Set up config with a token to avoid auth errors
      process.env.GITHUB_TOKEN = 'test-token';
      setConfig(createConfig());

      const result = resolveRepository('myorg/myrepo');
      expect(result).toEqual({ owner: 'myorg', repo: 'myrepo' });
    });

    it('returns null for invalid format (missing repo)', () => {
      process.env.GITHUB_TOKEN = 'test-token';
      setConfig(createConfig());

      const result = resolveRepository('myorg');
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      process.env.GITHUB_TOKEN = 'test-token';
      setConfig(createConfig());

      const result = resolveRepository('');
      expect(result).toBeNull();
    });
  });

  describe('with GITHUB_REPOSITORY env var', () => {
    it('falls back to GITHUB_REPOSITORY when no argument provided', () => {
      process.env.GITHUB_TOKEN = 'test-token';
      process.env.GITHUB_REPOSITORY = 'envorg/envrepo';
      setConfig(createConfig());

      const result = resolveRepository();
      expect(result).toEqual({ owner: 'envorg', repo: 'envrepo' });
    });

    it('explicit argument takes precedence over GITHUB_REPOSITORY', () => {
      process.env.GITHUB_TOKEN = 'test-token';
      process.env.GITHUB_REPOSITORY = 'envorg/envrepo';
      setConfig(createConfig());

      const result = resolveRepository('argorg/argrepo');
      expect(result).toEqual({ owner: 'argorg', repo: 'argrepo' });
    });
  });

  describe('with GITHUB_OWNER and GITHUB_REPO env vars', () => {
    it('falls back to GITHUB_OWNER/GITHUB_REPO when no argument and no GITHUB_REPOSITORY', () => {
      process.env.GITHUB_TOKEN = 'test-token';
      process.env.GITHUB_OWNER = 'ownerorg';
      process.env.GITHUB_REPO = 'ownerrepo';
      setConfig(createConfig());

      const result = resolveRepository();
      expect(result).toEqual({ owner: 'ownerorg', repo: 'ownerrepo' });
    });

    it('GITHUB_REPOSITORY takes precedence over GITHUB_OWNER/GITHUB_REPO', () => {
      process.env.GITHUB_TOKEN = 'test-token';
      process.env.GITHUB_REPOSITORY = 'repoorg/reporepo';
      process.env.GITHUB_OWNER = 'ownerorg';
      process.env.GITHUB_REPO = 'ownerrepo';
      setConfig(createConfig());

      const result = resolveRepository();
      expect(result).toEqual({ owner: 'repoorg', repo: 'reporepo' });
    });

    it('returns null when only GITHUB_OWNER is set (missing GITHUB_REPO)', () => {
      process.env.GITHUB_TOKEN = 'test-token';
      process.env.GITHUB_OWNER = 'ownerorg';
      setConfig(createConfig());

      const result = resolveRepository();
      expect(result).toBeNull();
    });

    it('returns null when only GITHUB_REPO is set (missing GITHUB_OWNER)', () => {
      process.env.GITHUB_TOKEN = 'test-token';
      process.env.GITHUB_REPO = 'ownerrepo';
      setConfig(createConfig());

      const result = resolveRepository();
      expect(result).toBeNull();
    });
  });

  describe('with no configuration', () => {
    it('returns null when no argument and no env vars', () => {
      process.env.GITHUB_TOKEN = 'test-token';
      setConfig(createConfig());

      const result = resolveRepository();
      expect(result).toBeNull();
    });

    it('returns null for undefined argument with no default', () => {
      process.env.GITHUB_TOKEN = 'test-token';
      setConfig(createConfig());

      const result = resolveRepository(undefined);
      expect(result).toBeNull();
    });
  });
});
