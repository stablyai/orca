// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import type * as FileNameSortModule from '../../../../../../shared/file-name-sort'
import type * as SourceControlTreeModule from '../../source-control-tree'
import type * as SubmoduleExpansionModule from './submodule-expansion'

const counters = vi.hoisted(() => ({
  compareFileNames: 0,
  buildGitStatusSourceControlTree: 0,
  buildSourceControlTree: 0,
  flattenSourceControlTree: 0,
  injectExpandedSubmoduleRows: 0,
  injectExpandedSubmoduleEntries: 0
}))

/** Lets a test swap in a comparator that is deliberately not a total order. */
const comparatorOverride = vi.hoisted(() => ({
  current: null as ((a: string, b: string) => number) | null
}))

vi.mock('../../../../../../shared/file-name-sort', async (importOriginal) => {
  const actual = await importOriginal<typeof FileNameSortModule>()
  return {
    ...actual,
    compareFileNames: (a: string, b: string) => {
      counters.compareFileNames += 1
      return comparatorOverride.current
        ? comparatorOverride.current(a, b)
        : actual.compareFileNames(a, b)
    }
  }
})

vi.mock('../../source-control-tree', async (importOriginal) => {
  const actual = await importOriginal<typeof SourceControlTreeModule>()
  return {
    ...actual,
    buildGitStatusSourceControlTree: (
      ...args: Parameters<typeof actual.buildGitStatusSourceControlTree>
    ) => {
      counters.buildGitStatusSourceControlTree += 1
      return actual.buildGitStatusSourceControlTree(...args)
    },
    buildSourceControlTree: ((...args: unknown[]) => {
      counters.buildSourceControlTree += 1
      return (actual.buildSourceControlTree as (...a: unknown[]) => unknown)(...args)
    }) as typeof actual.buildSourceControlTree,
    flattenSourceControlTree: ((...args: unknown[]) => {
      counters.flattenSourceControlTree += 1
      return (actual.flattenSourceControlTree as (...a: unknown[]) => unknown)(...args)
    }) as typeof actual.flattenSourceControlTree
  }
})

vi.mock('./submodule-expansion', async (importOriginal) => {
  const actual = await importOriginal<typeof SubmoduleExpansionModule>()
  return {
    ...actual,
    injectExpandedSubmoduleRows: ((...args: unknown[]) => {
      counters.injectExpandedSubmoduleRows += 1
      return (actual.injectExpandedSubmoduleRows as (...a: unknown[]) => unknown)(...args)
    }) as typeof actual.injectExpandedSubmoduleRows,
    injectExpandedSubmoduleEntries: ((...args: unknown[]) => {
      counters.injectExpandedSubmoduleEntries += 1
      return (actual.injectExpandedSubmoduleEntries as (...a: unknown[]) => unknown)(...args)
    }) as typeof actual.injectExpandedSubmoduleEntries
  }
})

const { compareFileNames } = await import('../../../../../../shared/file-name-sort')
const { getSourceControlFileFilterState, filterSourceControlPathEntries } =
  await import('./file-filter')
const { useSourceControlFileProjection } = await import('./use-file-projection')

const NO_ENTRIES: GitStatusEntry[] = []
const NO_COLLAPSED_TREE_DIRS = new Set<string>()
const NO_EXPANDED_SUBMODULES = new Set<string>()
const NO_COLLAPSED_SECTIONS = new Set<string>()
const NO_SUBMODULE_STATUS = {}
const GROUP_ORDER = ['unstaged', 'staged', 'untracked'] as const

type ProjectionProps = {
  entries: GitStatusEntry[]
  branchEntries: GitBranchChangeEntry[]
  filterQuery: string
  sourceControlViewMode: SourceControlViewMode
}

function renderProjection(initialProps: ProjectionProps) {
  return renderHook(
    (props: ProjectionProps) =>
      useSourceControlFileProjection({
        entries: props.entries,
        branchEntries: props.branchEntries,
        filterQuery: props.filterQuery,
        sourceControlGroupOrder: GROUP_ORDER,
        activeWorktreeId: 'wt-1',
        worktreePath: '/repo',
        isFolder: false,
        collapsedTreeDirs: NO_COLLAPSED_TREE_DIRS,
        expandedSubmoduleKeys: NO_EXPANDED_SUBMODULES,
        submoduleStatusByKey: NO_SUBMODULE_STATUS,
        sourceControlViewMode: props.sourceControlViewMode,
        collapsedSections: NO_COLLAPSED_SECTIONS
      }),
    { initialProps }
  )
}

function makeBranchEntries(count: number): GitBranchChangeEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/area-${index % 7}/nested/deep-${index % 13}/file-${index}.ts`,
    status: 'modified' as const
  }))
}

/** Numeric collation, case variants, unicode, collator ties, and an exact duplicate path. */
const ORDERING_FIXTURE: GitBranchChangeEntry[] = [
  { path: 'migrations/100.sql', status: 'modified' },
  { path: 'migrations/9.sql', status: 'modified' },
  { path: 'migrations/99.sql', status: 'added' },
  { path: 'migrations/02.sql', status: 'modified' },
  { path: 'migrations/2.sql', status: 'deleted' },
  { path: 'src/Button.tsx', status: 'modified' },
  { path: 'src/button.tsx', status: 'added' },
  { path: 'src/éclair.ts', status: 'modified' },
  { path: 'src/eclair.ts', status: 'deleted' },
  { path: 'src/Éclair.ts', status: 'modified' },
  { path: 'src/日本語.ts', status: 'added' },
  { path: 'src/dup.ts', status: 'modified' },
  { path: 'src/dup.ts', status: 'added' }
]

/** The pre-change implementation: filter, then copy-and-sort. */
function legacyFilterThenSort(
  entries: GitBranchChangeEntry[],
  filterQuery: string
): GitBranchChangeEntry[] {
  const state = getSourceControlFileFilterState(filterQuery)
  return [...filterSourceControlPathEntries(entries, state)].sort((a, b) =>
    compareFileNames(a.path, b.path)
  )
}

function makeStatusEntries(count: number): GitStatusEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/area-${index % 7}/nested/deep-${index % 13}/file-${index}.ts`,
    status: 'modified' as const,
    area: (['unstaged', 'staged', 'untracked'] as const)[index % 3]
  }))
}

/**
 * Deliberately not a total order: every path under the same top-level directory compares equal, so
 * distinct paths tie. Sort-before-filter must still match filter-before-sort under it.
 */
function compareTopLevelDirOnly(a: string, b: string): number {
  const dirA = a.slice(0, a.indexOf('/'))
  const dirB = b.slice(0, b.indexOf('/'))
  return dirA < dirB ? -1 : dirA > dirB ? 1 : 0
}

/** Big enough that V8 leaves binary insertion sort for TimSort, where instability would show. */
function makeTieHeavyEntries(count: number): GitBranchChangeEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    // Scrambled so the tie order is not already the sorted order.
    path: `dir-${(index * 7) % 3}/file-${(index * 31) % count}.ts`,
    status: 'modified' as const
  }))
}

beforeEach(() => {
  comparatorOverride.current = null
  for (const key of Object.keys(counters) as (keyof typeof counters)[]) {
    counters[key] = 0
  }
})

describe('useSourceControlFileProjection branch entry ordering', () => {
  it('sorts committed branch entries once across many filter changes', () => {
    const branchEntries = makeBranchEntries(400)
    const { rerender } = renderProjection({
      entries: NO_ENTRIES,
      branchEntries,
      filterQuery: '',
      sourceControlViewMode: 'list'
    })

    const comparesForInitialSort = counters.compareFileNames
    expect(comparesForInitialSort).toBeGreaterThan(0)

    for (const filterQuery of ['f', 'fi', 'fil', 'file', 'file-', 'file-1']) {
      rerender({ entries: NO_ENTRIES, branchEntries, filterQuery, sourceControlViewMode: 'list' })
    }

    expect(counters.compareFileNames).toBe(comparesForInitialSort)
  })

  it('produces the same order as the previous filter-then-sort for every filter', () => {
    const { result, rerender } = renderProjection({
      entries: NO_ENTRIES,
      branchEntries: ORDERING_FIXTURE,
      filterQuery: '',
      sourceControlViewMode: 'list'
    })

    for (const filterQuery of ['', 'src', 'MIGRATIONS', 'é', '9', 'dup', 'no-match']) {
      rerender({
        entries: NO_ENTRIES,
        branchEntries: ORDERING_FIXTURE,
        filterQuery,
        sourceControlViewMode: 'list'
      })
      expect(result.current.filteredBranchEntries).toEqual(
        legacyFilterThenSort(ORDERING_FIXTURE, filterQuery)
      )
    }
  })

  // Guards the invariant the sort-before-filter swap actually rests on: a stable sort, not a total
  // order. If sortedBranchEntries ever stops preserving the original order of tied paths, this
  // diverges from filter-then-sort even though every total-order fixture above still passes.
  it('matches filter-then-sort under a comparator that is not a total order', () => {
    comparatorOverride.current = compareTopLevelDirOnly
    const branchEntries = makeTieHeavyEntries(300)
    const { result, rerender } = renderProjection({
      entries: NO_ENTRIES,
      branchEntries,
      filterQuery: '',
      sourceControlViewMode: 'list'
    })

    for (const filterQuery of ['', 'dir-1', 'file-1', 'file-12', '7.ts', 'no-match']) {
      rerender({ entries: NO_ENTRIES, branchEntries, filterQuery, sourceControlViewMode: 'list' })
      expect(result.current.filteredBranchEntries.map((entry) => entry.path)).toEqual(
        legacyFilterThenSort(branchEntries, filterQuery).map((entry) => entry.path)
      )
    }
  })

  it('does not mutate the store-owned branch entry array', () => {
    const branchEntries = [...ORDERING_FIXTURE]
    renderProjection({
      entries: NO_ENTRIES,
      branchEntries,
      filterQuery: '',
      sourceControlViewMode: 'list'
    })

    expect(branchEntries).toEqual(ORDERING_FIXTURE)
  })
})

describe('useSourceControlFileProjection view-mode gating', () => {
  const entries = makeStatusEntries(120)
  const branchEntries = makeBranchEntries(120)

  it('builds no tree projection in list mode', () => {
    const { result } = renderProjection({
      entries,
      branchEntries,
      filterQuery: '',
      sourceControlViewMode: 'list'
    })

    expect(counters.buildGitStatusSourceControlTree).toBe(0)
    expect(counters.buildSourceControlTree).toBe(0)
    expect(counters.flattenSourceControlTree).toBe(0)
    expect(counters.injectExpandedSubmoduleRows).toBe(0)
    expect(counters.injectExpandedSubmoduleEntries).toBeGreaterThan(0)
    expect(result.current.visibleTreeRowsBySection).toEqual({})
    expect(result.current.visibleBranchTreeRows).toEqual([])
  })

  it('builds no list projection in tree mode', () => {
    const { result } = renderProjection({
      entries,
      branchEntries,
      filterQuery: '',
      sourceControlViewMode: 'tree'
    })

    expect(counters.injectExpandedSubmoduleEntries).toBe(0)
    expect(counters.buildGitStatusSourceControlTree).toBeGreaterThan(0)
    expect(counters.buildSourceControlTree).toBeGreaterThan(0)
    expect(result.current.visibleListRowsBySection).toEqual({})
  })

  it('has the other mode fully projected on the first render after a switch', () => {
    const { result, rerender } = renderProjection({
      entries,
      branchEntries,
      filterQuery: '',
      sourceControlViewMode: 'list'
    })
    const listRows = result.current.visibleListRowsBySection
    const listSelectionCount = result.current.visibleSelectionEntries.length
    expect(listSelectionCount).toBe(entries.length)

    rerender({ entries, branchEntries, filterQuery: '', sourceControlViewMode: 'tree' })

    expect(result.current.visibleListRowsBySection).toEqual({})
    expect(result.current.visibleBranchTreeRows.length).toBeGreaterThan(0)
    expect(
      Object.values(result.current.visibleTreeRowsBySection).reduce(
        (total, rows) => total + rows.length,
        0
      )
    ).toBeGreaterThan(0)
    expect(result.current.visibleSelectionEntries.length).toBe(listSelectionCount)

    rerender({ entries, branchEntries, filterQuery: '', sourceControlViewMode: 'list' })

    expect(result.current.visibleTreeRowsBySection).toEqual({})
    expect(result.current.visibleBranchTreeRows).toEqual([])
    expect(result.current.visibleListRowsBySection).toEqual(listRows)
  })
})
