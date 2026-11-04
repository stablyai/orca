import { describe, expect, it } from 'vitest'
import type { DirCache, TreeNode } from './file-explorer-types'
import { createVisibleFileExplorerRowProjection } from './useFileExplorerVisibleRowProjection'
import { getEffectiveFileExplorerIgnoredPaths } from './use-file-explorer-ignored-paths'

function row(relativePath: string, isDirectory = false, depth?: number): TreeNode {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    isDirectory,
    depth: depth ?? relativePath.split('/').length - 1
  }
}

function cache(childrenByPath: Record<string, TreeNode[]>): Record<string, DirCache> {
  const dirCache: Record<string, DirCache> = {}
  for (const [path, children] of Object.entries(childrenByPath)) {
    dirCache[path] = { children }
  }
  return dirCache
}

function input(
  childrenByPath: Record<string, TreeNode[]>,
  expandedPaths: string[] = []
): Parameters<typeof createVisibleFileExplorerRowProjection>[0] {
  return {
    dirCache: cache(childrenByPath),
    expanded: new Set(expandedPaths),
    worktreePath: '/repo'
  }
}

describe('file explorer visible row projection', () => {
  it('walks expanded directories and skips cached descendants of collapsed directories', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input(
        {
          '/repo': [row('src', true, 0), row('collapsed', true, 0), row('root.ts', false, 0)],
          '/repo/src': [row('src/index.ts', false, 1)],
          '/repo/collapsed': [row('collapsed/hidden.ts', false, 1)]
        },
        ['/repo/src']
      ),
      {
        ignoredSet: new Set(),
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src',
      'src/index.ts',
      'collapsed',
      'root.ts'
    ])
    expect(projection.hasPath('/repo/collapsed/hidden.ts')).toBe(false)
  })

  it('does not fall back to the partial cached tree while recursive file filtering is loading', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input(
        {
          '/repo': [row('src', true, 0)],
          '/repo/src': [row('src/FileExplorer.tsx', false, 1)]
        },
        ['/repo/src']
      ),
      {
        ignoredSet: new Set(),
        nameFilter: {
          query: 'FileExplorer',
          relativePaths: null
        },
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleCount()).toBe(0)
  })

  it('does not reuse ignored paths across worktree contexts', () => {
    expect(
      getEffectiveFileExplorerIgnoredPaths({
        activeWorktreeId: 'worktree-2',
        canLoadIgnoredPaths: true,
        ignoredPathResult: {
          activeWorktreeId: 'worktree-1',
          paths: ['out'],
          worktreePath: '/repo'
        },
        worktreePath: '/repo'
      })
    ).toEqual([])

    expect(
      getEffectiveFileExplorerIgnoredPaths({
        activeWorktreeId: 'worktree-1',
        canLoadIgnoredPaths: true,
        ignoredPathResult: {
          activeWorktreeId: 'worktree-1',
          paths: ['out'],
          worktreePath: '/repo'
        },
        worktreePath: '/other-repo'
      })
    ).toEqual([])
  })
})
