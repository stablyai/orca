import { describe, expect, it } from 'vitest'
import type { DirCache, TreeNode } from './file-explorer-types'
import {
  createVisibleFileExplorerRowProjection,
  getEffectiveFileExplorerIgnoredPaths,
  getFileExplorerIgnoredQueryRelativePaths
} from './useFileExplorerVisibleRowProjection'

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
    dirCache[path] = { children, loading: false }
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
  it('keeps dotfiles and ignored files visible when toggles are on', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input({
        '/repo': [row('src/index.ts'), row('.env'), row('dist/bundle.js')]
      }),
      {
        ignoredSet: new Set(['dist']),
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleCount()).toBe(3)
    expect(projection.getVisibleSlice(0, 2).map((entry) => entry.relativePath)).toEqual([
      'src/index.ts',
      '.env',
      'dist/bundle.js'
    ])
  })

  it('filters dotfiles before building the visible path map', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input({
        '/repo': [
          row('src/index.ts'),
          row('.env'),
          row('.config/settings.json'),
          row('src/.generated/output.ts')
        ]
      }),
      {
        ignoredSet: new Set(),
        showDotfiles: false,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src/index.ts'
    ])
    expect(projection.hasPath('/repo/.env')).toBe(false)
  })

  it('filters ignored files and descendants when git-ignored files are hidden', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input(
        {
          '/repo': [row('src', true, 0), row('dist', true, 0), row('dist2', true, 0), row('.env')],
          '/repo/src': [row('src/index.ts', false, 1)],
          '/repo/dist': [row('dist/bundle.js', false, 1)],
          '/repo/dist2': [row('dist2/bundle.js', false, 1)]
        },
        ['/repo/src', '/repo/dist', '/repo/dist2']
      ),
      {
        ignoredSet: new Set(['dist', '.env']),
        showDotfiles: true,
        showGitIgnoredFiles: false
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src',
      'src/index.ts',
      'dist2',
      'dist2/bundle.js'
    ])
  })

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

  it('queries git ignored paths only for dotfile-visible rows', () => {
    const treeInput = input({
      '/repo': [row('src/index.ts'), row('.env'), row('src/.generated/output.ts')]
    })

    expect(getFileExplorerIgnoredQueryRelativePaths(treeInput, true)).toEqual([
      'src/index.ts',
      '.env',
      'src/.generated/output.ts'
    ])
    expect(getFileExplorerIgnoredQueryRelativePaths(treeInput, false)).toEqual(['src/index.ts'])
  })

  it('queries ignored paths only through expanded directories', () => {
    const treeInput = input(
      {
        '/repo': [row('src', true, 0), row('collapsed', true, 0)],
        '/repo/src': [row('src/index.ts', false, 1)],
        '/repo/collapsed': [row('collapsed/hidden.ts', false, 1)]
      },
      ['/repo/src']
    )

    expect(getFileExplorerIgnoredQueryRelativePaths(treeInput, true)).toEqual([
      'src',
      'src/index.ts',
      'collapsed'
    ])
  })

  it('keeps same-worktree ignored paths while an expanded-folder query is loading', () => {
    const previousRelativePaths = ['out', 'src']

    expect(
      getEffectiveFileExplorerIgnoredPaths({
        activeWorktreeId: 'worktree-1',
        canLoadIgnoredPaths: true,
        ignoredPathResult: {
          activeWorktreeId: 'worktree-1',
          paths: ['out'],
          relativePaths: previousRelativePaths,
          worktreePath: '/repo'
        },
        worktreePath: '/repo'
      })
    ).toEqual(['out'])
  })

  it('does not reuse ignored paths across worktree contexts', () => {
    expect(
      getEffectiveFileExplorerIgnoredPaths({
        activeWorktreeId: 'worktree-2',
        canLoadIgnoredPaths: true,
        ignoredPathResult: {
          activeWorktreeId: 'worktree-1',
          paths: ['out'],
          relativePaths: ['out'],
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
          relativePaths: ['out'],
          worktreePath: '/repo'
        },
        worktreePath: '/other-repo'
      })
    ).toEqual([])
  })
})
