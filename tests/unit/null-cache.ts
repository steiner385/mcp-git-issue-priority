import { vi } from 'vitest';
import { CacheService } from '../../src/services/cache.js';

export function makeNullCache(): CacheService {
  return {
    getIssues: vi.fn().mockResolvedValue(null),
    setIssues: vi.fn().mockResolvedValue(undefined),
    invalidateIssues: vi.fn().mockResolvedValue(undefined),
    getLabels: vi.fn().mockResolvedValue(null),
    setLabels: vi.fn().mockResolvedValue(undefined),
    invalidateLabels: vi.fn().mockResolvedValue(undefined),
    getPrStatus: vi.fn().mockResolvedValue(null),
    setPrStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
}
