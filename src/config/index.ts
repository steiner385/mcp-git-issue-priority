import { homedir } from 'os';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { execFileSync } from 'child_process';

export interface Config {
  baseDir: string;
  locksDir: string;
  workflowDir: string;
  logsDir: string;
  githubToken: string;
  sessionId: string;
  defaultRepository?: { owner: string; repo: string };
}

const BASE_DIR_NAME = '.mcp-git-issue-priority';

export function getBaseDir(): string {
  return join(homedir(), BASE_DIR_NAME);
}

export function getLocksDir(): string {
  return join(getBaseDir(), 'locks');
}

export function getWorkflowDir(): string {
  return join(getBaseDir(), 'workflow');
}

export function getLogsDir(): string {
  return join(getBaseDir(), 'logs');
}

export function getBatchesDir(): string {
  return join(getBaseDir(), 'batches');
}

export async function ensureDirectories(): Promise<void> {
  const dirs = [getBaseDir(), getLocksDir(), getWorkflowDir(), getLogsDir(), getBatchesDir()];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

export function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Parses default repository from environment variables.
 * Priority: GITHUB_REPOSITORY > GITHUB_OWNER+GITHUB_REPO
 */
function getDefaultRepository(): { owner: string; repo: string } | undefined {
  // Try GITHUB_REPOSITORY first (owner/repo format)
  const ghRepo = process.env.GITHUB_REPOSITORY;
  if (ghRepo) {
    const [owner, repo] = ghRepo.split('/');
    if (owner && repo) {
      return { owner, repo };
    }
  }

  // Fall back to GITHUB_OWNER + GITHUB_REPO (both must be set)
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (owner && repo) {
    return { owner, repo };
  }

  return undefined;
}

/**
 * Attempts to get a GitHub token from the GitHub CLI (`gh auth token`).
 * Returns null if gh is not installed or not authenticated.
 */
function getGitHubCliToken(): string | null {
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function createConfig(githubToken?: string): Config {
  // Try sources in order: explicit param, env var, GitHub CLI
  const token = githubToken ?? process.env.GITHUB_TOKEN ?? getGitHubCliToken();
  if (!token) {
    throw new Error(
      'GitHub authentication required. Either:\n' +
        '  1. Set GITHUB_TOKEN environment variable, or\n' +
        '  2. Install and authenticate GitHub CLI: gh auth login'
    );
  }

  return {
    baseDir: getBaseDir(),
    locksDir: getLocksDir(),
    workflowDir: getWorkflowDir(),
    logsDir: getLogsDir(),
    githubToken: token,
    sessionId: generateSessionId(),
    defaultRepository: getDefaultRepository(),
  };
}

let globalConfig: Config | null = null;

export function getConfig(): Config {
  if (!globalConfig) {
    globalConfig = createConfig();
  }
  return globalConfig;
}

export function setConfig(config: Config): void {
  globalConfig = config;
}

export function resetConfig(): void {
  globalConfig = null;
}
