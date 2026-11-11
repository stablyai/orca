import { describe, expect, it } from 'vitest'
import { createNameFilteredFileExplorerProjection } from './file-explorer-name-filter-projection'
import { buildIgnoredSet } from '../../../../lib/source-control/paths/git-path-decoration'

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
})
