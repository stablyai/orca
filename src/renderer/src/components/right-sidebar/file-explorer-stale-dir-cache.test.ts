import { describe, expect, it } from 'vitest'
import type { TreeNode } from './file-explorer-types'
import { decideExpandedDirLoad } from './file-explorer-stale-dir-cache'

describe('decideExpandedDirLoad', () => {
  const children = [{ name: 'gone.ts', path: '/repo/src/gone.ts' } as TreeNode]

  it('re-reads a cached dir whose listing the last full refresh skipped', () => {
    expect(decideExpandedDirLoad({ children }, true)).toBe('reload')
  })
})
