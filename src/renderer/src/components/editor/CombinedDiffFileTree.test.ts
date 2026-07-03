import { describe, expect, it, vi } from 'vitest'
import {
  createCombinedDiffSectionIndexMap,
  getCombinedDiffFileTreeNavigationIndex,
  getCombinedDiffFileTreeSectionKey,
  handleCombinedDiffFileTreeNavigation
} from './CombinedDiffFileTree'
import {
  COMBINED_DIFF_FILE_TREE_QUERY_MAX_BYTES,
  getFilteredCombinedDiffFileTreeEntries,
  isCombinedDiffFileTreeQueryTooLarge
} from './combined-diff-file-tree-model'
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'

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

  it('expands a collapsed target section and scrolls to its index', () => {
    const entry: GitBranchChangeEntry = { path: 'src/view.ts', status: 'modified' }
    const toggleSection = vi.fn()
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
      scrollToIndex
    })

    expect(index).toBe(1)
    expect(toggleSection).toHaveBeenCalledWith(1)
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
})
