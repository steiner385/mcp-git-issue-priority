# Contributing to MCP GitHub Issue Priority Server

Thank you for your interest in contributing! This project welcomes contributions from the community via pull requests.

## Project Governance

This project is maintained by [@steiner385](https://github.com/steiner385), who retains sole control over the source code. All contributions are reviewed and merged at the maintainer's discretion.

## How to Contribute

### Reporting Issues

1. **Search existing issues** first to avoid duplicates
2. Use the issue templates when available
3. Provide clear reproduction steps for bugs
4. Include relevant environment details (Node.js version, OS, etc.)

### Submitting Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Open an issue first** to discuss significant changes before implementing
3. **Follow the code style** - run `npm run lint` before submitting
4. **Write tests** for new functionality
5. **Update documentation** if your changes affect usage
6. **Keep PRs focused** - one feature or fix per PR

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/mcp-git-issue-priority.git
cd mcp-git-issue-priority

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Run linting
npm run lint
```

### Code Style

- **TypeScript** with strict mode enabled
- **ES Modules** (type: module)
- **ESLint** and **Prettier** for formatting
- Descriptive variable and function names
- Comments for complex logic only

### Commit Messages

Use clear, descriptive commit messages:

```
feat: add support for custom label colors
fix: handle rate limiting in GitHub API calls
docs: update installation instructions
test: add unit tests for priority scoring
refactor: simplify lock acquisition logic
```

### Testing Requirements

- All new features must include unit tests
- Tests must pass before PR can be merged: `npm test`
- Maintain or improve code coverage
- Use Vitest for all tests

### Pull Request Process

1. Ensure all tests pass and linting is clean
2. Update the README.md if adding new features or changing behavior
3. Fill out the PR template completely
4. Wait for review - the maintainer will provide feedback or merge

### What We're Looking For

- Bug fixes with clear reproduction and solution
- Performance improvements with benchmarks
- Documentation improvements
- Test coverage improvements
- New features that align with the project's goals

### What We're NOT Looking For

- Breaking changes without discussion
- Features that significantly increase complexity
- Changes that don't include tests
- PRs that don't follow the code style

## Code of Conduct

- Be respectful and constructive in all interactions
- Focus on the code, not the person
- Accept feedback gracefully
- Help others learn and grow

## Questions?

Open a [discussion](https://github.com/steiner385/mcp-git-issue-priority/discussions) or [issue](https://github.com/steiner385/mcp-git-issue-priority/issues) if you have questions about contributing.

## License

By contributing to this project, you agree that your contributions will be licensed under the MIT License.
