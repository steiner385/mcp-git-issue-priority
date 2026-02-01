import { describe, it, expect } from 'vitest';
import { getBatchesDir } from '../../src/config/index.js';
import { homedir } from 'os';
import { join } from 'path';

describe('Config', () => {
  describe('getBatchesDir', () => {
    it('returns correct batches directory path', () => {
      const expected = join(homedir(), '.mcp-git-issue-priority', 'batches');
      expect(getBatchesDir()).toBe(expected);
    });
  });
});
