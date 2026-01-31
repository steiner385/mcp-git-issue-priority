import { homedir } from 'os';
import { join } from 'path';
import { mkdir } from 'fs/promises';

export interface Config {
  baseDir: string;
  locksDir: string;
  workflowDir: string;
  logsDir: string;
  githubToken: string;
  sessionId: string;
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

export async function ensureDirectories(): Promise<void> {
  const dirs = [getBaseDir(), getLocksDir(), getWorkflowDir(), getLogsDir()];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

export function generateSessionId(): string {
  return crypto.randomUUID();
}

export function createConfig(githubToken?: string): Config {
  const token = githubToken ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }

  return {
    baseDir: getBaseDir(),
    locksDir: getLocksDir(),
    workflowDir: getWorkflowDir(),
    logsDir: getLogsDir(),
    githubToken: token,
    sessionId: generateSessionId(),
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
