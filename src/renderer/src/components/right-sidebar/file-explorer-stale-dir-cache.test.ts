import { describe, expect, it } from 'vitest'
import type { DirCache, TreeNode } from './file-explorer-types'
import { collectStaleDirCachePaths, decideExpandedDirLoad } from './file-explorer-stale-dir-cache'

function cache(...dirPaths: string[]): Record<string, DirCache> {
  return Object.fromEntries(dirPaths.map((dirPath) => [dirPath, { children: [], loading: false }]))
}

describe('collectStaleDirCachePaths', () => {
  it('marks a cached dir that a full refresh will not re-read', () => {
    expect(
      collectStaleDirCachePaths(cache('/repo', '/repo/src', '/repo/docs'), '/repo', new Set())
    ).toEqual(['/repo/src', '/repo/docs'])
  })

  it('never marks the root or a currently expanded dir', () => {
    expect(
      collectStaleDirCachePaths(
        cache('/repo', '/repo/src', '/repo/docs'),
        '/repo',
        new Set(['/repo/src'])
      )
    ).toEqual(['/repo/docs'])
  })

  it('returns nothing when the cache holds only refreshed dirs', () => {
    expect(
      collectStaleDirCachePaths(cache('/repo', '/repo/src'), '/repo', new Set(['/repo/src']))
    ).toEqual([])
  })
})

describe('decideExpandedDirLoad', () => {
  const children = [{ name: 'gone.ts', path: '/repo/src/gone.ts' } as TreeNode]

  it('re-reads a cached dir whose listing the last full refresh skipped', () => {
    expect(decideExpandedDirLoad({ children, loading: false }, true)).toBe('reload')
  })

  it('trusts a cached listing that is not stale', () => {
    expect(decideExpandedDirLoad({ children, loading: false }, false)).toBe('skip')
  })

  it('reads a dir that has never been listed', () => {
    expect(decideExpandedDirLoad(undefined, false)).toBe('load')
    expect(decideExpandedDirLoad({ children: [], loading: false }, false)).toBe('load')
  })

  it('never stacks a read on one already in flight, stale or not', () => {
    expect(decideExpandedDirLoad({ children, loading: true }, true)).toBe('skip')
    expect(decideExpandedDirLoad({ children: [], loading: true }, false)).toBe('skip')
  })
})
