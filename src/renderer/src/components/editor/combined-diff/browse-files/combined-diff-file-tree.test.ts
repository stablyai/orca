import { describe, expect, it } from 'vitest'

import {
  createCombinedDiffSectionIndexMap,
  getCombinedDiffFileTreeSectionKey
} from '../resolve-changes/combined-diff-section-identity'
import { getCombinedDiffFileTreeNavigationIndex } from './combined-diff-file-tree-navigation'

import {
  COMBINED_DIFF_FILE_TREE_QUERY_MAX_BYTES,
  getFilteredCombinedDiffFileTreeEntries,
  isCombinedDiffFileTreeQueryTooLarge
} from './combined-diff-file-tree-filter'

import {
  buildCombinedDiffBranchTreeRoots,
  getViewedCombinedDiffTreeVisibility
} from './combined-diff-file-tree-model'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'

describe('CombinedDiffFileTree navigation mapping', () => {
  it('disambiguates uncommitted entries with the same path by area', () => {
    const staged: GitStatusEntry = { path: 'src/App.tsx', status: 'modified', area: 'staged' }
    const unstaged: GitStatusEntry = { path: 'src/App.tsx', status: 'modified', area: 'unstaged' }
    const sectionIndexByKey = createCombinedDiffSectionIndexMap([
      { key: 'unstaged:src/App.tsx' },
      { key: 'staged:src/App.tsx' }
    ])

    expect(getCombinedDiffFileTreeSectionKey('uncommitted', unstaged)).toBe('unstaged:src/App.tsx')
    expect(
      getCombinedDiffFileTreeNavigationIndex({
        mode: 'uncommitted',
        entry: unstaged,
        sectionIndexByKey
      })
    ).toBe(0)
    expect(
      getCombinedDiffFileTreeNavigationIndex({
        mode: 'uncommitted',
        entry: staged,
        sectionIndexByKey
      })
    ).toBe(1)
  })

  it('rejects oversized pasted filters before reading diff entries', () => {
    const oversizedQuery = 'secret-diff-filter'.repeat(COMBINED_DIFF_FILE_TREE_QUERY_MAX_BYTES)
    const entry = {
      get path(): string {
        throw new Error('oversized diff filters must not scan paths')
      },
      get status(): GitBranchChangeEntry['status'] {
        throw new Error('oversized diff filters must not scan statuses')
      }
    } as GitBranchChangeEntry

    expect(isCombinedDiffFileTreeQueryTooLarge(oversizedQuery)).toBe(true)
    expect(
      getFilteredCombinedDiffFileTreeEntries({
        entries: [entry],
        mode: 'branch',
        query: oversizedQuery,
        excludedExtensions: new Set(),
        includeViewed: true,
        viewedSectionKeys: new Set()
      })
    ).toEqual([])
  })

  it('overlays viewed files while preserving filtered-tree compaction', () => {
    const entries: GitBranchChangeEntry[] = [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/nested/b.ts', status: 'modified' },
      { path: 'docs/readme.md', status: 'modified' }
    ]
    const roots = buildCombinedDiffBranchTreeRoots('branch', entries)
    const visibility = getViewedCombinedDiffTreeVisibility({
      roots,
      collapsedDirectoryKeys: new Set(),
      mode: 'branch',
      viewedSectionKeys: new Set(['combined-branch:src/a.ts', 'combined-branch:docs/readme.md'])
    })

    expect(
      visibility.rows.filter((node) => node.type === 'file').map((node) => node.entry.path)
    ).toEqual(['src/nested/b.ts'])
    expect(visibility.visibleFileCount).toBe(1)
    const compactedDirectory = visibility.rows.find((node) => node.type === 'directory')
    expect(compactedDirectory).toMatchObject({
      path: 'src/nested',
      name: 'src/nested',
      fileCount: 1
    })
    expect(compactedDirectory && visibility.visibleFileCounts.get(compactedDirectory.key)).toBe(1)
  })

  it('preserves a collapsed directory boundary while filtering viewed siblings', () => {
    const entries: GitBranchChangeEntry[] = [
      { path: 'src/a/one.ts', status: 'modified' },
      { path: 'src/b/two.ts', status: 'modified' }
    ]
    const roots = buildCombinedDiffBranchTreeRoots('branch', entries)
    const visibility = getViewedCombinedDiffTreeVisibility({
      roots,
      collapsedDirectoryKeys: new Set(['dir::combined-branch::src']),
      mode: 'branch',
      viewedSectionKeys: new Set(['combined-branch:src/b/two.ts'])
    })

    expect(visibility.rows).toEqual([
      expect.objectContaining({
        type: 'directory',
        key: 'dir::combined-branch::src',
        path: 'src'
      })
    ])
    expect(visibility.visibleFileCount).toBe(1)
  })
})
