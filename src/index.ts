#!/usr/bin/env node

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

async function main() {
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

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`MCP Issue Priority Server started (session: ${config.sessionId})`);
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}

main();
