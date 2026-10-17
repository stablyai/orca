import { describe, expect, it } from 'vitest'
import { nestedStatusKey, nestedStatusKeysForWorktrees } from './nested-status-key'

describe('nested status keys', () => {
  it('finds only the nested keys of the given workspaces', () => {
    const record = {
      'wt-1': 1,
      [nestedStatusKey('wt-1', '/a/repo')]: 2,
      [nestedStatusKey('wt-10', '/a/repo')]: 3
    }
    expect(nestedStatusKeysForWorktrees(record, ['wt-1'])).toEqual(['wt-1::/a/repo'])
  })
})
