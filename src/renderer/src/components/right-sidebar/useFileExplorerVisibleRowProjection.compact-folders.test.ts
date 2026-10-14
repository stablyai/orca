import { describe, expect, it } from 'vitest'
import type { DirCache, TreeNode } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import { createVisibleFileExplorerRowProjection } from './useFileExplorerVisibleRowProjection'
import { getFileExplorerNameFilterExpandedPaths } from './file-explorer-name-filter-projection'

function row(relativePath: string, isDirectory: boolean): TreeNode {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    isDirectory,
    depth: relativePath.split('/').length - 1
  }
}

function listings(childrenByPath: Record<string, TreeNode[]>): Record<string, DirCache> {
  const dirCache: Record<string, DirCache> = {}
  for (const [path, children] of Object.entries(childrenByPath)) {
    dirCache[path] = { children }
  }
  return dirCache
}

/** Each row as drawn: two spaces per indentation level, then its label. */
function drawn(projection: FileExplorerRowProjection): string[] {
  return Array.from({ length: projection.getVisibleCount() }, (_, index) => {
    const folders = [...projection.getCompactedAncestors(index), projection.getRowAtIndex(index)]
    const label = folders.map((folder) => folder?.name).join('/')
    return `${'  '.repeat(projection.getRowDepth(index))}${label}`
  })
}

describe('createVisibleFileExplorerRowProjection with compact folders', () => {
  it('folds expanded folders whose listing holds a single folder', () => {
    const projection = createVisibleFileExplorerRowProjection(
      {
        dirCache: listings({
          '/repo': [row('src', true), row('build.gradle', false)],
          '/repo/src': [row('src/main', true)],
          '/repo/src/main': [row('src/main/java', true)],
          '/repo/src/main/java': [
            row('src/main/java/App.java', false),
            row('src/main/java/util', true)
          ]
        }),
        expanded: new Set(['/repo/src', '/repo/src/main', '/repo/src/main/java']),
        worktreePath: '/repo'
      },
      { ignoredSet: new Set(), showDotfiles: true, showGitIgnoredFiles: true, compactFolders: true }
    )

    expect(drawn(projection)).toEqual(['src/main/java', '  App.java', '  util', 'build.gradle'])
  })

  it('draws every folder on its own row while compact folders is off', () => {
    const projection = createVisibleFileExplorerRowProjection(
      {
        dirCache: listings({
          '/repo': [row('src', true)],
          '/repo/src': [row('src/main', true)],
          '/repo/src/main': [row('src/main/App.java', false)]
        }),
        expanded: new Set(['/repo/src', '/repo/src/main']),
        worktreePath: '/repo'
      },
      {
        ignoredSet: new Set(),
        showDotfiles: true,
        showGitIgnoredFiles: true,
        compactFolders: false
      }
    )

    expect(drawn(projection)).toEqual(['src', '  main', '    App.java'])
  })

  it('does not fold a collapsed folder even when its listing is still cached', () => {
    const projection = createVisibleFileExplorerRowProjection(
      {
        dirCache: listings({
          '/repo': [row('src', true)],
          '/repo/src': [row('src/main', true)],
          '/repo/src/main': [row('src/main/App.java', false)]
        }),
        expanded: new Set(),
        worktreePath: '/repo'
      },
      { ignoredSet: new Set(), showDotfiles: true, showGitIgnoredFiles: true, compactFolders: true }
    )

    expect(drawn(projection)).toEqual(['src'])
  })

  it('folds an expanded folder into its only child while that child stays collapsed', () => {
    const projection = createVisibleFileExplorerRowProjection(
      {
        dirCache: listings({
          '/repo': [row('src', true)],
          '/repo/src': [row('src/main', true)],
          '/repo/src/main': [row('src/main/App.java', false)]
        }),
        expanded: new Set(['/repo/src']),
        worktreePath: '/repo'
      },
      { ignoredSet: new Set(), showDotfiles: true, showGitIgnoredFiles: true, compactFolders: true }
    )

    expect(drawn(projection)).toEqual(['src/main'])
    expect(projection.getRowAtIndex(0)?.path).toBe('/repo/src/main')
  })

  it('keeps an expanded folder whose listing has not loaded on its own row', () => {
    const projection = createVisibleFileExplorerRowProjection(
      {
        dirCache: listings({ '/repo': [row('src', true)] }),
        expanded: new Set(['/repo/src']),
        worktreePath: '/repo'
      },
      { ignoredSet: new Set(), showDotfiles: true, showGitIgnoredFiles: true, compactFolders: true }
    )

    expect(drawn(projection)).toEqual(['src'])
  })

  it('counts only visible entries, so a hidden dotfile does not stop the fold', () => {
    const input = {
      dirCache: listings({
        '/repo': [row('src', true)],
        '/repo/src': [row('src/.gitkeep', false), row('src/main', true)],
        '/repo/src/main': [row('src/main/App.java', false)]
      }),
      expanded: new Set(['/repo/src', '/repo/src/main']),
      worktreePath: '/repo'
    }

    const dotfilesHidden = createVisibleFileExplorerRowProjection(input, {
      ignoredSet: new Set(),
      showDotfiles: false,
      showGitIgnoredFiles: true,
      compactFolders: true
    })
    const dotfilesShown = createVisibleFileExplorerRowProjection(input, {
      ignoredSet: new Set(),
      showDotfiles: true,
      showGitIgnoredFiles: true,
      compactFolders: true
    })

    expect(drawn(dotfilesHidden)).toEqual(['src/main', '  App.java'])
    expect(drawn(dotfilesShown)).toEqual(['src', '  .gitkeep', '  main', '    App.java'])
  })

  it('counts only visible entries, so a hidden git-ignored folder does not stop the fold', () => {
    const input = {
      dirCache: listings({
        '/repo': [row('app', true)],
        '/repo/app': [row('app/build', true), row('app/src', true)],
        '/repo/app/src': [row('app/src/index.ts', false)]
      }),
      expanded: new Set(['/repo/app', '/repo/app/src']),
      worktreePath: '/repo'
    }

    const ignoredHidden = createVisibleFileExplorerRowProjection(input, {
      ignoredSet: new Set(['app/build']),
      showDotfiles: true,
      showGitIgnoredFiles: false,
      compactFolders: true
    })
    const ignoredShown = createVisibleFileExplorerRowProjection(input, {
      ignoredSet: new Set(['app/build']),
      showDotfiles: true,
      showGitIgnoredFiles: true,
      compactFolders: true
    })

    expect(drawn(ignoredHidden)).toEqual(['app/src', '  index.ts'])
    expect(drawn(ignoredShown)).toEqual(['app', '  build', '  src', '    index.ts'])
  })

  it('splits the row when a file appears beside the only child folder, and joins it again when the file goes', () => {
    const expanded = new Set(['/repo/a', '/repo/a/b'])
    const options = {
      ignoredSet: new Set<string>(),
      showDotfiles: true,
      showGitIgnoredFiles: true,
      compactFolders: true
    }
    const singleChild = listings({
      '/repo': [row('a', true)],
      '/repo/a': [row('a/b', true)],
      '/repo/a/b': [row('a/b/x.ts', false)]
    })
    const withNewFile = listings({
      '/repo': [row('a', true)],
      '/repo/a': [row('a/b', true), row('a/new.ts', false)],
      '/repo/a/b': [row('a/b/x.ts', false)]
    })

    const before = createVisibleFileExplorerRowProjection(
      { dirCache: singleChild, expanded, worktreePath: '/repo' },
      options
    )
    const afterCreate = createVisibleFileExplorerRowProjection(
      { dirCache: withNewFile, expanded, worktreePath: '/repo' },
      options
    )
    const afterDelete = createVisibleFileExplorerRowProjection(
      { dirCache: singleChild, expanded, worktreePath: '/repo' },
      options
    )

    expect(drawn(before)).toEqual(['a/b', '  x.ts'])
    expect(drawn(afterCreate)).toEqual(['a', '  b', '    x.ts', '  new.ts'])
    expect(drawn(afterDelete)).toEqual(['a/b', '  x.ts'])
  })

  it('keeps the parent of an open create input on its own row', () => {
    const projection = createVisibleFileExplorerRowProjection(
      {
        dirCache: listings({
          '/repo': [row('a', true)],
          '/repo/a': [row('a/b', true)],
          '/repo/a/b': [row('a/b/x.ts', false)]
        }),
        expanded: new Set(['/repo/a', '/repo/a/b']),
        worktreePath: '/repo'
      },
      {
        ignoredSet: new Set(),
        showDotfiles: true,
        showGitIgnoredFiles: true,
        compactFolders: true,
        compactFoldersStopPath: '/repo/a'
      }
    )

    expect(drawn(projection)).toEqual(['a', '  b', '    x.ts'])
    expect(projection.getInsertIndexAfterSubtree('/repo/a', '/repo')).toBe(3)
  })

  it('keeps a folder whose last read failed on its own row so its error stays visible', () => {
    const projection = createVisibleFileExplorerRowProjection(
      {
        dirCache: {
          '/repo': { children: [row('a', true)] },
          '/repo/a': { children: [row('a/b', true)], error: 'EACCES: permission denied' }
        },
        expanded: new Set(['/repo/a']),
        worktreePath: '/repo'
      },
      { ignoredSet: new Set(), showDotfiles: true, showGitIgnoredFiles: true, compactFolders: true }
    )

    expect(drawn(projection)).toEqual(['a', '  b'])
  })

  it('folds single-folder chains in file-name filter results', () => {
    const projection = createVisibleFileExplorerRowProjection(
      {
        dirCache: listings({ '/repo': [row('src', true), row('docs', true)] }),
        expanded: new Set(),
        worktreePath: '/repo'
      },
      {
        ignoredSet: new Set(),
        nameFilter: {
          query: 'app',
          relativePaths: ['src/main/java/com/App.java', 'docs/guide.md']
        },
        showDotfiles: true,
        showGitIgnoredFiles: true,
        compactFolders: true
      }
    )

    expect(drawn(projection)).toEqual(['src/main/java/com', '  App.java'])
    expect([...getFileExplorerNameFilterExpandedPaths(projection, 'app')]).toEqual([
      '/repo/src/main/java/com'
    ])
  })

  it('draws a scoped root at the indentation the explorer subtracts for that scope', () => {
    const projection = createVisibleFileExplorerRowProjection(
      {
        dirCache: listings({
          '/repo/packages/app': [row('packages/app/src', true)],
          '/repo/packages/app/src': [row('packages/app/src/lib', true)],
          '/repo/packages/app/src/lib': [row('packages/app/src/lib/index.ts', false)]
        }),
        expanded: new Set(['/repo/packages/app/src', '/repo/packages/app/src/lib']),
        worktreePath: '/repo',
        displayRootPath: '/repo/packages/app'
      },
      { ignoredSet: new Set(), showDotfiles: true, showGitIgnoredFiles: true, compactFolders: true }
    )

    expect(projection.getVisibleCount()).toBe(2)
    expect(projection.getCompactedAncestors(0).map((folder) => folder.name)).toEqual(['src'])
    expect([projection.getRowDepth(0), projection.getRowDepth(1)]).toEqual([2, 3])
  })
})
