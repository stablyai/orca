import { describe, expect, it, vi } from 'vitest'
import {
  createCombinedDiffSectionIndexMap,
  getCombinedDiffFileTreeSectionKey
} from '../resolve-changes/combined-diff-section-identity'
import {
  getCombinedDiffFileTreeNavigationIndex,
  handleCombinedDiffFileTreeNavigation
} from './combined-diff-file-tree-navigation'
import {
  COMBINED_DIFF_FILE_TREE_QUERY_MAX_BYTES,
  getCombinedDiffBranchEntriesInTreeOrder,
  getCombinedDiffFileTreeEntriesMatchingStaticFilters,
  getFilteredCombinedDiffFileTreeEntries,
  isCombinedDiffFileTreeQueryTooLarge,
  isCombinedDiffSectionViewed
} from './combined-diff-file-tree-filter'
import {
  buildCombinedDiffBranchTreeRoots,
  getViewedCombinedDiffTreeVisibility
} from './combined-diff-file-tree-model'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'

describe('CombinedDiffFileTree navigation mapping', () => {
  it('does not count deferred sections as viewed', () => {
    expect(isCombinedDiffSectionViewed({ loading: false, loadOnDemand: true })).toBe(false)
    expect(isCombinedDiffSectionViewed({ loading: false, loadOnDemand: false })).toBe(true)
    expect(isCombinedDiffSectionViewed({ loading: false })).toBe(true)
    expect(isCombinedDiffSectionViewed({ loading: true, loadOnDemand: false })).toBe(false)
  })

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

  it('maps branch and commit entries to combined section prefixes', () => {
    const entry: GitBranchChangeEntry = { path: 'src/view.ts', status: 'renamed' }

    expect(getCombinedDiffFileTreeSectionKey('all', entry)).toBe('combined-branch:src/view.ts')
    expect(getCombinedDiffFileTreeSectionKey('branch', entry)).toBe('combined-branch:src/view.ts')
    expect(getCombinedDiffFileTreeSectionKey('commit', entry)).toBe('combined-commit:src/view.ts')
  })

  it('keeps all-changes local and branch entries separate', () => {
    const localEntry: GitStatusEntry = {
      path: 'src/view.ts',
      status: 'modified',
      area: 'unstaged'
    }
    const branchEntry: GitBranchChangeEntry = { path: 'src/view.ts', status: 'modified' }

    expect(getCombinedDiffFileTreeSectionKey('all', localEntry)).toBe('unstaged:src/view.ts')
    expect(getCombinedDiffFileTreeSectionKey('all', branchEntry)).toBe(
      'combined-branch:src/view.ts'
    )
  })

  it('orders commit entries to match the file tree', () => {
    const entries: GitBranchChangeEntry[] = [
      { path: 'src/zebra.ts', status: 'modified' },
      { path: 'README.md', status: 'modified' },
      { path: 'src/alpha.ts', status: 'modified' },
      { path: 'docs/guide.md', status: 'modified' }
    ]

    expect(
      getCombinedDiffBranchEntriesInTreeOrder('commit', entries).map((entry) => entry.path)
    ).toEqual(['docs/guide.md', 'src/alpha.ts', 'src/zebra.ts', 'README.md'])
  })

  it('expands a collapsed target section and scrolls to its index', () => {
    const entry: GitBranchChangeEntry = { path: 'src/view.ts', status: 'modified' }
    const toggleSection = vi.fn()
    const loadSection = vi.fn()
    const scrollToIndex = vi.fn()
    const index = handleCombinedDiffFileTreeNavigation({
      mode: 'branch',
      entry,
      sections: [{ collapsed: false }, { collapsed: true }],
      sectionIndexByKey: createCombinedDiffSectionIndexMap([
        { key: 'combined-branch:src/other.ts' },
        { key: 'combined-branch:src/view.ts' }
      ]),
      toggleSection,
      loadSection,
      scrollToIndex
    })

    expect(index).toBe(1)
    expect(toggleSection).toHaveBeenCalledWith(1)
    expect(loadSection).toHaveBeenCalledWith(1)
    expect(scrollToIndex).toHaveBeenCalledWith(1)
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

  it('rejects oversized whitespace before trimming diff filters', () => {
    expect(
      getFilteredCombinedDiffFileTreeEntries({
        entries: [],
        mode: 'branch',
        query: ' '.repeat(COMBINED_DIFF_FILE_TREE_QUERY_MAX_BYTES + 1),
        excludedExtensions: new Set(),
        includeViewed: true,
        viewedSectionKeys: new Set()
      })
    ).toEqual([])
  })

  it('retains the structural entry list when only viewed state can change', () => {
    const entries: GitBranchChangeEntry[] = [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'modified' }
    ]

    expect(
      getCombinedDiffFileTreeEntriesMatchingStaticFilters({
        entries,
        query: '',
        excludedExtensions: new Set()
      })
    ).toBe(entries)
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
