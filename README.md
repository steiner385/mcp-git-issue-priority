# MCP GitHub Issue Priority Server

A Model Context Protocol (MCP) server that enables AI assistants to manage GitHub issues with deterministic priority scoring and concurrency-safe selection.

## Features

- **Priority-Based Issue Selection**: Deterministic scoring algorithm ensures consistent issue prioritization across sessions
- **Concurrency-Safe Locking**: File-based atomic locking prevents multiple AI sessions from selecting the same issue
- **Guided Workflow**: 8-phase workflow (selection → research → branch → implementation → testing → commit → pr → review) with transition validation
- **Automatic Labeling**: Creates and manages priority (`P0`-`P3`), type (`bug`, `feature`, `chore`, `docs`), and status labels
- **Stale Lock Detection**: Automatically detects and cleans up locks from dead processes
- **Audit Logging**: JSON Lines logging for all operations with 30-day retention

## Installation

### Prerequisites

- Node.js 20+
- GitHub authentication (one of the following):
  - GitHub CLI (`gh`) installed and authenticated, OR
  - A GitHub personal access token with `repo` scope

### Install from GitHub

```bash
npm install -g github:steiner385/mcp-git-issue-priority
```

This will automatically build the package after installation.

### Install from source

```bash
git clone https://github.com/steiner385/mcp-git-issue-priority.git
cd mcp-git-issue-priority
npm install
npm link
```

## Configuration

### GitHub Authentication

The server supports multiple authentication methods (checked in order):

1. **Environment variable** - Set `GITHUB_TOKEN`:
   ```bash
   export GITHUB_TOKEN="ghp_your_personal_access_token"
   ```

2. **GitHub CLI** - If `gh` is installed and authenticated, the token is retrieved automatically:
   ```bash
   gh auth login  # One-time setup
   ```

If you're already using GitHub CLI or VS Code with GitHub authentication, option 2 provides seamless authentication without managing tokens manually.

### Claude Code Configuration

Add to your Claude Code MCP settings (`~/.claude.json` or project settings):

```json
{
  "mcpServers": {
    "github-issue-priority": {
      "command": "mcp-git-issue-priority"
    }
  }
}
```

If you're using GitHub CLI authentication, no additional configuration is needed. Otherwise, add your token:

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

## Priority Scoring Algorithm

Issues are scored using a deterministic formula:

```
score = (basePoints + ageBonus) * blockingMultiplier
```

- **Base Points**: P0=1000, P1=100, P2=10, P3=1
- **Age Bonus**: +1 point per day since creation (max 365)
- **Blocking Multiplier**: 1.5x for issues with "blocking" label
- **Tiebreaker**: Earlier creation date wins (FIFO)

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

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Support

- [Open an issue](https://github.com/steiner385/mcp-git-issue-priority/issues) for bug reports or feature requests
- Check existing issues before creating new ones
