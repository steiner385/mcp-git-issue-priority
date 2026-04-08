#!/usr/bin/env node

import { exec } from 'child_process';
import { platform } from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createConfig, ensureDirectories, setConfig } from './config/index.js';
import { initializeLogger } from './services/logging.js';
import { initializeGitHubService } from './services/github.js';

import { registerCreateIssueTool } from './tools/create-issue.js';
import { registerSelectNextIssueTool } from './tools/select-next-issue.js';
import { registerAdvanceWorkflowTool } from './tools/advance-workflow.js';
import { registerReleaseLockTool } from './tools/release-lock.js';
import { registerForceClaimTool } from './tools/force-claim.js';
import { registerGetWorkflowStatusTool } from './tools/get-workflow-status.js';
import { registerListBacklogTool } from './tools/list-backlog.js';
import { registerSyncBacklogLabelsTool } from './tools/sync-backlog-labels.js';
import { registerGetPrStatusTool } from './tools/get-pr-status.js';
import { registerBulkUpdateIssuesTool } from './tools/bulk-update-issues.js';
import { registerImplementBatchTool } from './tools/implement-batch.js';
import { registerBatchContinueTool } from './tools/batch-continue.js';
import { registerGetWorkflowAnalyticsTool } from './tools/get-workflow-analytics.js';

const REPO_URL = 'https://github.com/steiner385/mcp-git-issue-priority';
const VERSION = '1.1.0';

function openUrl(url: string): void {
  const plat = platform();
  const cmd =
    plat === 'darwin' ? 'open' : plat === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

function handleCliArgs(): boolean {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
mcp-git-issue-priority v${VERSION}

MCP server for GitHub issue prioritization and workflow management.

Usage:
  mcp-git-issue-priority          Start the MCP server (for MCP hosts)
  mcp-git-issue-priority --help   Show this help message
  mcp-git-issue-priority --version  Show version
  mcp-git-issue-priority --feedback Open the feedback/issues page

Documentation: ${REPO_URL}#readme
`);
    return true;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION);
    return true;
  }

  if (args.includes('--feedback')) {
    console.log('Opening feedback page...');
    openUrl(`${REPO_URL}/issues`);
    return true;
  }

  return false;
}

async function main() {
  // Handle CLI arguments before starting server
  if (handleCliArgs()) {
    process.exit(0);
  }

  try {
    const config = createConfig();
    setConfig(config);

    await ensureDirectories();

    initializeLogger(config.sessionId);
    initializeGitHubService(config.githubToken);

    const server = new McpServer({
      name: 'mcp-git-issue-priority',
      version: '1.0.0',
    });

    registerCreateIssueTool(server);
    registerSelectNextIssueTool(server);
    registerAdvanceWorkflowTool(server);
    registerReleaseLockTool(server);
    registerForceClaimTool(server);
    registerGetWorkflowStatusTool(server);
    registerListBacklogTool(server);
    registerSyncBacklogLabelsTool(server);
    registerGetPrStatusTool(server);
    registerBulkUpdateIssuesTool(server);
    registerImplementBatchTool(server);
    registerBatchContinueTool(server);
    registerGetWorkflowAnalyticsTool(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`MCP Issue Priority Server started (session: ${config.sessionId})`);
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}

main();
