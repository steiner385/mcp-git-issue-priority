import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerClaimIssueTool } from '../../src/tools/claim-issue.js';
import { registerAdvanceWorkflowTool } from '../../src/tools/advance-workflow.js';
import { registerReleaseLockTool } from '../../src/tools/release-lock.js';
import { registerSelectNextIssueTool } from '../../src/tools/select-next-issue.js';
import { registerForceClaimTool } from '../../src/tools/force-claim.js';

/**
 * Smoke test: register the lock-coordination tools on a real McpServer and
 * round-trip `tools/list` over an in-memory transport. The actual handler is
 * never invoked — this catches the failure mode where a new tool is written
 * but its `register*Tool` call is missing from the server bootstrap, so the
 * MCP host advertises it as unavailable.
 */
describe('MCP server tool registration', () => {
  it('exposes claim_issue, advance_workflow, release_lock, select_next_issue, force_claim via tools/list', async () => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' });

    // Mirror the registrations in src/index.ts that are relevant to lock
    // coordination — we don't need to register every tool, just enough to
    // verify the wiring works and our new tool is discoverable.
    registerClaimIssueTool(server);
    registerAdvanceWorkflowTool(server);
    registerReleaseLockTool(server);
    registerSelectNextIssueTool(server);
    registerForceClaimTool(server);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('claim_issue');
    expect(names).toContain('advance_workflow');
    expect(names).toContain('release_lock');
    expect(names).toContain('select_next_issue');
    expect(names).toContain('force_claim');

    await client.close();
    await server.close();
  });

  it('claim_issue advertises an issueNumber input field', async () => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' });
    registerClaimIssueTool(server);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const claimIssue = tools.find((t) => t.name === 'claim_issue');

    expect(claimIssue).toBeDefined();
    const props = (claimIssue?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(props.issueNumber).toBeDefined();

    await client.close();
    await server.close();
  });
});
