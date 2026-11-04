import { describe, expect, it } from 'vitest'
import {
  createNameFilteredFileExplorerProjection,
  getFileExplorerNameFilterIgnoredQueryRelativePaths
} from './file-explorer-name-filter-projection'
import { buildIgnoredSet } from '../../../../lib/git-path-decoration'

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

  it('scopes a literal-backslash directory without selecting its nested counterpart', () => {
    const rows = project('/repo', ['a\\b/file.txt', 'a/b/other.txt'], {
      displayRootPath: '/repo/a\\b'
    })
    expect(rows.map((row) => row.relativePath)).toEqual(['a\\b/file.txt'])
  })

  it('shows matching files only within the visible, nonignored display scope', () => {
    const rows = project(
      '/repo',
      [
        'src/nested/visible.txt',
        'src/visible.txt',
        'src/nonmatching.ts',
        'src/.private/hidden.txt',
        'src/ignored/matching.txt',
        'other/outside.txt'
      ],
      {
        displayRootPath: '/repo/src',
        ignoredPaths: ['src/ignored/'],
        showDotfiles: false
      }
    )

    expect(rows.map((row) => row.relativePath)).toEqual([
      'src/nested',
      'src/nested/visible.txt',
      'src/visible.txt'
    ])
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
})
