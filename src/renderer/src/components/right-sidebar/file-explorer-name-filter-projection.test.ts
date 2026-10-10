import { describe, expect, it } from 'vitest'
import {
  createNameFilteredFileExplorerProjection,
  getFileExplorerNameFilterIgnoredQueryRelativePaths,
  getNameFilterCollapsedPathsAfterExpand,
  getNextNameFilterCollapsedPaths
} from './file-explorer-name-filter-projection'
import { buildIgnoredSet } from './status-display'

describe('getNextNameFilterCollapsedPaths', () => {
  it('collapses expanded filtered folders and expands collapsed filtered folders', () => {
    const collapsed = getNextNameFilterCollapsedPaths(new Set(), '/repo/src', true)
    expect([...collapsed]).toEqual(['/repo/src'])

    const expanded = getNextNameFilterCollapsedPaths(collapsed, '/repo/src', false)
    expect([...expanded]).toEqual([])
  })

  it('expands filtered folders without toggling unrelated collapsed paths', () => {
    const expanded = getNameFilterCollapsedPathsAfterExpand(
      new Set(['/repo/docs', '/repo/src']),
      '/repo/src'
    )

    expect([...expanded]).toEqual(['/repo/docs'])
  })
})

describe('name-filter filename identity', () => {
  function project(
    worktreePath: string,
    relativePaths: string[],
    options: { displayRootPath?: string; ignoredPaths?: string[]; showDotfiles?: boolean } = {}
  ) {
    return createNameFilteredFileExplorerProjection({
      worktreePath,
      displayRootPath: options.displayRootPath,
      nameFilter: { query: 'txt', relativePaths },
      ignoredSet: buildIgnoredSet(options.ignoredPaths, worktreePath),
      showDotfiles: options.showDotfiles ?? true,
      showGitIgnoredFiles: false
    }).getVisibleSlice(0, 100)
  }

  it.each(['/native/repo', '/ssh/repo\\root'])(
    'keeps literal backslashes separate from directories under %s',
    (root) => {
      const paths = ['a\\b.txt', 'a/b.txt', 'C:\\foo/a\\b.txt', '\\\\server/a\\b.txt']
      const files = project(root, paths).filter((row) => !row.isDirectory)
      expect(files.map((row) => row.relativePath).sort()).toEqual([...paths].sort())
      expect(files.map((row) => row.path).sort()).toEqual(
        paths.map((path) => `${root}/${path}`).sort()
      )
    }
  )

  it('scopes a literal-backslash directory without selecting its nested counterpart', () => {
    const rows = project('/repo', ['a\\b/file.txt', 'a/b/other.txt'], {
      displayRootPath: '/repo/a\\b'
    })
    expect(rows.map((row) => row.relativePath)).toEqual(['a\\b/file.txt'])
  })

  it('keeps ignored and dotfile identities distinct on POSIX', () => {
    const paths = ['a\\b.txt', 'a/b.txt', 'a\\.hidden.txt', 'a/.hidden.txt']
    const rows = project('/repo', paths, { ignoredPaths: ['a/b.txt'], showDotfiles: false })
    expect(rows.map((row) => row.relativePath).sort()).toEqual(['a\\.hidden.txt', 'a\\b.txt'])
    expect(
      getFileExplorerNameFilterIgnoredQueryRelativePaths(
        { query: 'txt', relativePaths: paths },
        false,
        '/repo'
      )
    ).toEqual(['a\\b.txt', 'a/b.txt', 'a\\.hidden.txt'])
    expect(
      project('/repo', paths, { ignoredPaths: ['a\\b.txt'] }).map((row) => row.relativePath)
    ).not.toContain('a\\b.txt')
  })

  it.each(['C:\\repo', '\\\\server\\share\\repo'])(
    'keeps Windows separator semantics under %s',
    (root) => {
      const paths = ['a\\b.txt', 'a/b.txt', 'a\\.hidden.txt']
      const files = project(root, paths, { showDotfiles: false }).filter((row) => !row.isDirectory)
      expect(files.map((row) => row.relativePath)).toEqual(['a/b.txt'])
      expect(files.map((row) => row.path)).toEqual([`${root}\\a\\b.txt`])
      expect(project(root, paths, { ignoredPaths: ['a\\'], showDotfiles: false })).toEqual([])
      expect(
        getFileExplorerNameFilterIgnoredQueryRelativePaths(
          { query: 'txt', relativePaths: paths },
          false,
          root
        )
      ).toEqual(['a/b.txt', 'a/b.txt'])
    }
  )
})
