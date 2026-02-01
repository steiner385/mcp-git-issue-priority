import { getConfig } from '../config/index.js';

export interface Repository {
  owner: string;
  repo: string;
}

/**
 * Resolves repository from explicit argument or falls back to default config.
 * Priority: explicit argument > config defaultRepository
 *
 * @param repository - Optional repository string in 'owner/repo' format
 * @returns Parsed repository or null if not available
 */
export function resolveRepository(repository?: string): Repository | null {
  // Try explicit argument first
  if (repository) {
    const [owner, repo] = repository.split('/');
    if (owner && repo) {
      return { owner, repo };
    }
  }

  // Fall back to default from config
  const config = getConfig();
  if (config.defaultRepository) {
    return config.defaultRepository;
  }

  return null;
}
