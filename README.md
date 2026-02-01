# MCP GitHub Issue Priority Server

A Model Context Protocol (MCP) server that enables AI assistants to manage GitHub issues with deterministic priority scoring and concurrency-safe selection.

## Quick Start

```bash
# 1. Install from npm (recommended)
npm install -g mcp-git-issue-priority

# 2. Authenticate (if not already using GitHub CLI)
gh auth login

# 3. Add to Claude Code (~/.claude.json)
```

```json
{
  "mcpServers": {
    "github-issue-priority": {
      "command": "mcp-git-issue-priority"
    }
  }
}
```

```bash
# 4. Restart Claude Code and verify
# The MCP tools should appear when you run /mcp
```

## Features

- **Priority-Based Issue Selection**: Deterministic scoring algorithm ensures consistent issue prioritization across sessions
- **Concurrency-Safe Locking**: File-based atomic locking prevents multiple AI sessions from selecting the same issue
- **Guided Workflow**: 8-phase workflow (selection → research → branch → implementation → testing → commit → pr → review) with transition validation
- **Automatic Labeling**: Creates and manages priority (`P0`-`P3`), type (`bug`, `feature`, `chore`, `docs`), and status labels
- **Stale Lock Detection**: Automatically detects and cleans up locks from dead processes
- **Audit Logging**: JSON Lines logging for all operations with 30-day retention

## Installation

### Prerequisites

- **Node.js 20+** - [Download](https://nodejs.org/)
- **GitHub CLI** (recommended) - [Install](https://cli.github.com/) and run `gh auth login`
  - Or: a GitHub personal access token with `repo` scope

### Install from npm (recommended)

```bash
npm install -g mcp-git-issue-priority
```

### Install specific version

```bash
npm install -g mcp-git-issue-priority@1.0.0
```

### Install from source

```bash
git clone https://github.com/steiner385/mcp-git-issue-priority.git
cd mcp-git-issue-priority
npm install && npm link
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| `command not found: mcp-git-issue-priority` | Ensure npm global bin is in your PATH: `npm bin -g` |
| `GitHub authentication required` | Run `gh auth login` or set `GITHUB_TOKEN` |
| Build errors during install | Ensure Node.js 20+ is installed: `node --version` |

## Configuration

### GitHub Authentication

The server supports two authentication methods:

#### Recommended: GitHub CLI (automatic)

If you have [GitHub CLI](https://cli.github.com/) installed and authenticated, the server automatically retrieves your token:

```bash
# One-time setup
gh auth login
```

This is the recommended approach - no manual token management required.

#### Alternative: Environment Variable

Set `GITHUB_TOKEN` with a [personal access token](https://github.com/settings/tokens) that has `repo` scope:

```bash
export GITHUB_TOKEN="ghp_your_personal_access_token"
```

Or configure it in your MCP settings (see below).

### Claude Code Configuration

Add to `~/.claude.json` (global) or `.claude/settings.json` (project):

```json
{
  "mcpServers": {
    "github-issue-priority": {
      "command": "mcp-git-issue-priority"
    }
  }
}
```

**Using a personal access token instead of GitHub CLI?** Add the token to the config:

```json
{
  "mcpServers": {
    "github-issue-priority": {
      "command": "mcp-git-issue-priority",
      "env": {
        "GITHUB_TOKEN": "ghp_your_personal_access_token"
      }
    }
  }
}
```

### Verify Installation

After restarting Claude Code:

1. Run `/mcp` to see available MCP servers
2. The `github-issue-priority` server should be listed with 13 tools
3. Try `list_backlog` on any repository to confirm it's working

## Available Tools

### `create_issue`

Create a new GitHub issue with mandatory priority and type labels.

```
Arguments:
  - title (required): Issue title
  - body (optional): Issue description
  - priority (required): P0 (critical) | P1 (high) | P2 (medium) | P3 (low)
  - type (required): bug | feature | chore | docs
  - repository (required): "owner/repo" format
```

### `select_next_issue`

Select and lock the highest-priority issue from the backlog. Uses deterministic scoring to ensure consistent selection.

```
Arguments:
  - repository (required): "owner/repo" format
  - type (optional): Filter by issue type
  - maxPriority (optional): Only consider issues at or above this priority
```

### `list_backlog`

List all open issues in priority order without acquiring locks (read-only).

```
Arguments:
  - repository (required): "owner/repo" format
  - type (optional): Filter by issue type
  - limit (optional): Maximum issues to return (default: 20)
```

### `advance_workflow`

Advance the workflow to the next phase for a locked issue.

```
Arguments:
  - issueNumber (required): Issue number to advance
  - targetPhase (required): research | branch | implementation | testing | commit | pr | review
  - repository (required): "owner/repo" format
  - testsPassed (optional): Required when advancing to 'commit' phase
  - prTitle (optional): Required for 'pr' phase
  - prBody (optional): Required for 'pr' phase
  - skipJustification (optional): Required if skipping phases
```

### `get_workflow_status`

Get the current workflow status for locked issues.

```
Arguments:
  - issueNumber (optional): Specific issue number
  - repository (optional): "owner/repo" format
```

### `release_lock`

Release lock on an issue (on completion, abandonment, or merge).

```
Arguments:
  - issueNumber (required): Issue number
  - reason (required): completed | abandoned | merged
  - repository (required): "owner/repo" format
```

### `force_claim`

Force claim an issue locked by another session (requires confirmation).

```
Arguments:
  - issueNumber (required): Issue number to claim
  - confirmation (required): Must be exactly "I understand this may cause conflicts"
  - repository (required): "owner/repo" format
```

### `sync_backlog_labels`

Detect and optionally fix issues missing required priority/type/status labels.

```
Arguments:
  - repository (required): "owner/repo" format
  - mode (optional): "report" (default) to list issues, "update" to apply labels
  - defaultPriority (optional): P0 | P1 | P2 | P3 (defaults to P2)
  - defaultType (optional): bug | feature | chore | docs (defaults to feature)
```

In **report mode**, returns a list of all issues missing labels with details about what's missing.

In **update mode**, applies default labels to issues:
- Missing priority → `priority:P2` (or specified default)
- Missing type → `type:feature` (or specified default)
- Missing status → `status:backlog`

### `get_pr_status`

Check CI status, approval state, and merge state of a pull request.

```
Arguments:
  - repository (required): "owner/repo" format
  - prNumber (required): Pull request number to check
```

### `bulk_update_issues`

Add/remove labels and close/reopen multiple issues at once.

```
Arguments:
  - repository (required): "owner/repo" format
  - issues (required): Array of issue numbers (1-50)
  - addLabels (optional): Labels to add
  - removeLabels (optional): Labels to remove
  - state (optional): "open" | "closed"
```

### `implement_batch`

Start implementing a batch of N issues in priority order. Returns the first issue to implement.

```
Arguments:
  - repository (required): "owner/repo" format
  - count (required): Number of issues to implement (1-10)
  - includeTypes (optional): Only include these issue types
  - excludeTypes (optional): Exclude these issue types
  - maxPriority (optional): Only P0, P1, etc.
```

### `batch_continue`

Continue batch implementation. Polls for PR merge, then returns next issue or completion.

```
Arguments:
  - batchId (required): Batch ID from implement_batch
  - prNumber (optional): PR number for current issue
```

### `get_workflow_analytics`

Get time-based workflow analytics: cycle time, phase breakdown, aging reports.

```
Arguments:
  - repository (required): "owner/repo" format
  - period (optional): "7d" | "30d" | "90d" | "all" (default: 30d)
```

## Priority Scoring Algorithm

Issues are scored using a deterministic formula:

```
score = (basePoints + ageBonus) * blockingMultiplier * blockedPenalty
```

- **Base Points**: P0=1000, P1=100, P2=10, P3=1
- **Age Bonus**: +1 point per day since creation (max 365)
- **Blocking Multiplier**: 1.5x for issues with "blocking" label
- **Blocked Penalty**: 0.1x for issues blocked by open parent issues (via GitHub sub-issues)
- **Tiebreaker**: Earlier creation date wins (FIFO)

### Dependency Detection

Issues with open parent issues (using GitHub's sub-issues feature) are automatically deprioritized with a 0.1x penalty. This ensures that blocked work sinks to the bottom of the backlog until its dependencies are resolved. Once a parent issue is closed, the child issue's priority returns to normal.

## Workflow Phases

1. **selection**: Issue selected and locked
2. **research**: Understanding the problem
3. **branch**: Feature branch created
4. **implementation**: Code changes in progress
5. **testing**: Running tests and validation
6. **commit**: Changes committed
7. **pr**: Pull request created
8. **review**: Awaiting review/merge

## Data Storage

All data is stored locally in `~/.mcp-git-issue-priority/`:

```
~/.mcp-git-issue-priority/
├── locks/          # Active lock files (.lockdata)
├── workflow/       # Workflow state files (.json)
└── logs/           # Audit logs (JSON Lines format)
```

## Development

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

### Lint

```bash
npm run lint
```

### Type Check

```bash
npm run typecheck
```

## Releasing (Maintainers)

### One-time Setup

1. Create an npm account at https://www.npmjs.com/
2. Go to https://www.npmjs.com/settings/tokens
3. Create an "Automation" token with "Publish" permission
4. Add to GitHub: Settings → Secrets → Actions → New secret named `NPM_TOKEN`

### Creating a Release

```bash
# Patch release (bug fixes): 1.0.0 → 1.0.1
npm version patch -m "Release v%s"
git push && git push --tags

# Minor release (new features): 1.0.0 → 1.1.0
npm version minor -m "Release v%s"
git push && git push --tags

# Major release (breaking changes): 1.0.0 → 2.0.0
npm version major -m "Release v%s"
git push && git push --tags
```

Pushing a tag triggers the release workflow which:
- Runs lint, build, and tests
- Creates a GitHub release with the tarball attached
- Publishes to npm registry

### Download Tracking

- **GitHub**: Releases page shows download count per `.tgz` asset
- **npm**: https://www.npmjs.com/package/mcp-git-issue-priority shows weekly downloads

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Support

- [Open an issue](https://github.com/steiner385/mcp-git-issue-priority/issues) for bug reports or feature requests
- Check existing issues before creating new ones
