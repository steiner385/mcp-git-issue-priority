# Default Repository Support

**Issue:** #3
**Date:** 2026-02-01

## Summary

Add support for default repository configuration via environment variables, reducing friction when working with a single repository.

## Current State

- GitHub CLI token detection: Already implemented in `src/config/index.ts`
- Default repository: Not implemented - every tool call requires `repository` argument

## Design

### Environment Variable Priority

Resolution order for repository:
1. Tool argument `repository` (explicit per-call)
2. `GITHUB_REPOSITORY` env var (`owner/repo` format)
3. `GITHUB_OWNER` + `GITHUB_REPO` env vars (both must be set)
4. Return `null` (tool errors with `REPO_REQUIRED`)

### Config Changes

Add `defaultRepository` to Config interface:

```typescript
export interface Config {
  // ... existing fields
  defaultRepository?: { owner: string; repo: string };
}
```

### New Utility

Create `src/utils/repository.ts` with shared `resolveRepository()` function that:
- Parses explicit repository argument if provided
- Falls back to global config's `defaultRepository`
- Returns `null` if neither available

### Tool Updates

All 13 tools replace their local `parseRepository()` with the shared utility import.

## Files Modified

- `src/config/index.ts` - Add defaultRepository parsing
- `src/utils/repository.ts` - New file
- `src/tools/*.ts` - 13 tool files updated

## Testing

- Unit tests for `resolveRepository()` covering all fallback scenarios
- Integration verification via existing tool tests
