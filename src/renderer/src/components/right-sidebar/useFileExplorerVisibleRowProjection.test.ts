import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirCache, TreeNode } from './file-explorer-types'
import {
  createVisibleFileExplorerRowProjection,
  getFileExplorerIgnoredQueryRelativePaths
} from './useFileExplorerVisibleRowProjection'
import { getEffectiveFileExplorerIgnoredPaths } from './use-file-explorer-ignored-paths'
import {
  FILE_EXPLORER_NAME_FILTER_QUERY_MAX_BYTES,
  getFileExplorerNameFilterExpandedPaths,
  getFileExplorerNameFilterIgnoredQueryRelativePaths,
  getFileExplorerNameFilterTokens
} from './file-explorer-name-filter-projection'

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

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('filters recursive file-list paths even when folders are not loaded in the tree cache', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input({
        '/repo': [row('src', true, 0), row('package.json', false, 0)]
      }),
      {
        ignoredSet: new Set(),
        nameFilter: {
          query: 'FileExplorer',
          relativePaths: [
            'src/components/right-sidebar/FileExplorer.tsx',
            'src/components/right-sidebar/Search.tsx'
          ]
        },
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src',
      'src/components',
      'src/components/right-sidebar',
      'src/components/right-sidebar/FileExplorer.tsx'
    ])
  })

  it('hides descendants under collapsed folders while a file-name filter is active', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input({
        '/repo': [row('docs', true, 0), row('src', true, 0)]
      }),
      {
        ignoredSet: new Set(),
        nameFilter: {
          query: 'ts',
          relativePaths: ['docs/guide.ts', 'src/components/FileExplorer.tsx', 'src/index.ts']
        },
        nameFilterCollapsedPaths: new Set(['/repo/src']),
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'docs',
      'docs/guide.ts',
      'src'
    ])
    expect([...getFileExplorerNameFilterExpandedPaths(projection, 'ts')]).toEqual(['/repo/docs'])
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

  it('marks ancestor folders as expanded only while a file-name filter is active', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input(
        {
          '/repo': [row('src', true, 0), row('package.json', false, 0)],
          '/repo/src': [row('src/FileExplorer.tsx', false, 1)]
        },
        []
      ),
      {
        ignoredSet: new Set(),
        nameFilter: {
          query: 'file',
          relativePaths: ['src/FileExplorer.tsx']
        },
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect([...getFileExplorerNameFilterExpandedPaths(projection, 'file')]).toEqual(['/repo/src'])
    expect([...getFileExplorerNameFilterExpandedPaths(projection, '')]).toEqual([])
  })

  it('applies dotfile and ignored visibility to file-name filter results', () => {
    const projection = createVisibleFileExplorerRowProjection(
      input(
        {
          '/repo': [row('.config', true, 0), row('dist', true, 0), row('src', true, 0)],
          '/repo/.config': [row('.config/FileExplorer.tsx', false, 1)],
          '/repo/dist': [row('dist/FileExplorer.js', false, 1)],
          '/repo/src': [row('src/FileExplorer.tsx', false, 1)]
        },
        []
      ),
      {
        ignoredSet: new Set(['dist']),
        nameFilter: {
          query: 'file',
          relativePaths: [
            '.config/FileExplorer.tsx',
            'dist/FileExplorer.js',
            'src/FileExplorer.tsx'
          ]
        },
        showDotfiles: false,
        showGitIgnoredFiles: false
      }
    )

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.relativePath)).toEqual([
      'src',
      'src/FileExplorer.tsx'
    ])
  })

  it('rejects oversized file-name filter queries before scanning recursive paths', () => {
    const oversizedQuery = 'secret-file-filter'.repeat(FILE_EXPLORER_NAME_FILTER_QUERY_MAX_BYTES)
    const nameFilter = {
      query: oversizedQuery,
      relativePaths: ['src/FileExplorer.tsx', 'docs/secret-file-filter.md']
    }

    const projection = createVisibleFileExplorerRowProjection(
      input({
        '/repo': [row('src', true, 0), row('docs', true, 0)]
      }),
      {
        ignoredSet: new Set(),
        nameFilter,
        showDotfiles: true,
        showGitIgnoredFiles: true
      }
    )

    expect(getFileExplorerNameFilterTokens(oversizedQuery)).toEqual([])
    expect(getFileExplorerNameFilterIgnoredQueryRelativePaths(nameFilter, true)).toEqual([])
    expect(projection.getVisibleCount()).toBe(0)
    expect([...getFileExplorerNameFilterExpandedPaths(projection, oversizedQuery)]).toEqual([])
  })

  it('tokenizes accepted pasted file-name filters without regex splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const query = ['  FileExplorer', String.fromCharCode(160), '\nStatus  '].join('')

    expect(getFileExplorerNameFilterTokens(query)).toEqual(['fileexplorer', 'status'])
    expect(split).not.toHaveBeenCalled()
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
    expect(
      getEffectiveFileExplorerIgnoredPaths({
        activeWorktreeId: 'worktree-1',
        canLoadIgnoredPaths: true,
        ignoredPathResult: {
          activeWorktreeId: 'worktree-1',
          paths: ['out'],
          worktreePath: '/repo'
        },
        worktreePath: '/repo'
      })
    ).toEqual(['out'])
  })

  it('does not read a missing ignored-path result when no worktree is active', () => {
    expect(
      getEffectiveFileExplorerIgnoredPaths({
        activeWorktreeId: null,
        canLoadIgnoredPaths: true,
        ignoredPathResult: null,
        worktreePath: null
      })
    ).toEqual([])
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
