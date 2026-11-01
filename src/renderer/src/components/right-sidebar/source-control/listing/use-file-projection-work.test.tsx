// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { useMemo } from 'react'
import { create } from 'zustand'
import type { AppState } from '@/store'
import { toBranchCompareSnapshot } from '@/store/slices/editor/git/git-status-reconciliation'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import type * as FileNameSortModule from '../../../../../../shared/file-name-sort'
import type * as SourceControlTreeModule from '../../../../../../shared/source-control-tree'
import type * as SubmoduleExpansionModule from './submodule-expansion'
import type * as FileProjectionModule from './use-file-projection'
import type * as RowOpeningModule from './use-row-opening'

const counters = vi.hoisted(() => ({
  compareFileNames: 0,
  buildGitStatusSourceControlTree: 0,
  buildSourceControlTree: 0,
  flattenSourceControlTree: 0,
  injectExpandedSubmoduleRows: 0,
  injectExpandedSubmoduleEntries: 0,
  branchKeys: 0,
  branchNodeVisits: 0,
  branchIngestions: 0
}))

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

vi.mock('../../../../../../shared/source-control-tree', async (importOriginal) => {
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
const { useSourceControlFileListing } = await import('./use-file-listing')

const editorStore = create<
  Pick<AppState, 'openFiles' | 'activeFileIdByWorktree' | 'activeTabTypeByWorktree'>
>(() => ({ openFiles: [], activeFileIdByWorktree: {}, activeTabTypeByWorktree: {} }))
vi.mock('@/store', () => ({
  useAppStore: (...args: Parameters<typeof editorStore>) => editorStore(...args)
}))
vi.mock('./use-submodule-status', () => ({
  useSourceControlSubmoduleStatus: () => ({
    expandedSubmoduleKeys: NO_EXPANDED_SUBMODULES,
    submoduleStatusByKey: NO_SUBMODULE_STATUS
  })
}))
vi.mock('../sync/use-git-history', () => ({ useSourceControlGitHistory: () => ({}) }))
vi.mock('../commit/use-bulk-actions', () => ({ useSourceControlBulkActions: () => ({}) }))

// Observe the real projection's output, leaving sorting/filtering/tree construction untouched.
vi.mock('./use-file-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof FileProjectionModule>()
  return {
    ...actual,
    useSourceControlFileProjection: (
      ...args: Parameters<typeof actual.useSourceControlFileProjection>
    ) => {
      const projection = actual.useSourceControlFileProjection(...args)
      return {
        ...projection,
        filteredBranchEntries: useMemo(
          () =>
            projection.filteredBranchEntries.map((entry) => ({
              ...entry,
              get path() {
                counters.branchKeys++
                return entry.path
              }
            })),
          [projection.filteredBranchEntries]
        ),
        visibleBranchTreeRows: useMemo(
          () =>
            projection.visibleBranchTreeRows.map((node) => ({
              ...node,
              get type() {
                counters.branchNodeVisits++
                return node.type
              },
              get key() {
                counters.branchKeys++
                return node.key
              }
            })),
          [projection.visibleBranchTreeRows]
        )
      }
    }
  }
})
vi.mock('./use-row-opening', async (importOriginal) => {
  const actual = await importOriginal<typeof RowOpeningModule>()
  return {
    ...actual,
    useSourceControlRowOpening: (args: Parameters<typeof actual.useSourceControlRowOpening>[0]) => {
      const visibleBranchRowKeys = useMemo(() => {
        const keys = [...args.visibleBranchRowKeys]
        keys[Symbol.iterator] = function* (): Generator<string, undefined, unknown> {
          for (let index = 0; index < keys.length; index++) {
            counters.branchIngestions++
            yield keys[index]
          }
        }
        return keys
      }, [args.visibleBranchRowKeys])
      return actual.useSourceControlRowOpening({ ...args, visibleBranchRowKeys })
    }
  }
})

const NO_ENTRIES: GitStatusEntry[] = []
const NO_COLLAPSED_TREE_DIRS = new Set<string>()
const NO_EXPANDED_SUBMODULES = new Set<string>()
const NO_COLLAPSED_SECTIONS = new Set<string>()
const NO_SUBMODULE_STATUS = {}
const GROUP_ORDER = ['unstaged', 'staged'] as const

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

/** Tie distinct paths by top-level directory to prove sort/filter equivalence does not require a total order. */
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

describe('useSourceControlFileProjection entry ordering', () => {
  it('sorts combined working changes once across filter changes', () => {
    const entries = makeStatusEntries(400)
    const branchEntries: GitBranchChangeEntry[] = []
    const { result, rerender } = renderProjection({
      entries,
      branchEntries,
      filterQuery: '',
      sourceControlViewMode: 'list'
    })
    const sections = result.current.displaySections
    const comparesForInitialSort = counters.compareFileNames
    expect(comparesForInitialSort).toBeGreaterThan(0)

    for (const filterQuery of ['f', 'file-1', 'no-match', '']) {
      rerender({ entries, branchEntries, filterQuery, sourceControlViewMode: 'list' })
      expect(result.current.displaySections).toEqual(
        sections
          .map((section) => ({
            ...section,
            items: section.items.filter((entry) => entry.path.includes(filterQuery))
          }))
          .filter((section) => section.items.length > 0)
      )
    }

    expect(counters.compareFileNames).toBe(comparesForInitialSort)
  })

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

  // Only stable sorting preserves tie order after filtering; total-order fixtures alone cannot detect this regression.
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

  it('preserves untracked selection keys in the combined Changes tree', () => {
    const { result } = renderProjection({
      entries: [
        { path: 'src/new.ts', area: 'untracked', status: 'untracked' },
        { path: 'src/tracked.ts', area: 'unstaged', status: 'modified' }
      ],
      branchEntries: [],
      filterQuery: '',
      sourceControlViewMode: 'tree'
    })
    expect(result.current.displaySections.map((section) => section.id)).toEqual(['unstaged'])
    expect(result.current.visibleSelectionEntries.map(({ key, area }) => ({ key, area }))).toEqual([
      { key: 'untracked::src/new.ts', area: 'untracked' },
      { key: 'unstaged::src/tracked.ts', area: 'unstaged' }
    ])
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

describe('branch current-row projection contract', () => {
  it.each([100, 1000])('bounds real listing/opening work for %i committed files', (count) => {
    const summary = {
      baseRef: 'main',
      baseOid: 'base',
      compareRef: 'feature',
      headOid: 'head',
      mergeBase: 'base',
      changedFiles: count,
      status: 'ready' as const
    }
    const branchEntries = Array.from({ length: count }, (_, index) => ({
      path: `src/${index % 2 ? 'other' : 'match'}/file-${index}.ts`,
      status: 'modified' as const
    }))
    const openFiles: AppState['openFiles'] = [0, 1].map((index) => ({
      id: `file-${index}`,
      worktreeId: 'wt-1',
      relativePath: branchEntries[index].path,
      filePath: `/repo/${branchEntries[index].path}`,
      language: 'typescript',
      isDirty: false,
      mode: 'diff',
      diffSource: 'branch',
      branchCompare: toBranchCompareSnapshot(summary)
    }))
    editorStore.setState({
      openFiles,
      activeFileIdByWorktree: { 'wt-1': 'file-0' },
      activeTabTypeByWorktree: { 'wt-1': 'editor' }
    })
    let props: Parameters<typeof useSourceControlFileListing>[0] = {
      activeRemoteActionSequence: null,
      activeRepoTarget: null,
      activeWorktreeId: 'wt-1',
      branchEntries,
      branchName: 'feature',
      branchSummary: summary,
      collapsedSections: NO_COLLAPSED_SECTIONS,
      collapsedTreeDirs: NO_COLLAPSED_TREE_DIRS,
      compareBaseRef: 'main',
      entries: NO_ENTRIES,
      filterQuery: '',
      isBranchVisible: true,
      isFolder: false,
      isGitHistoryExpanded: false,
      isMac: true,
      refreshActiveGitStatusAfterMutation: async () => {},
      remoteActionError: null,
      repositoryHuge: undefined,
      rightSidebarTab: 'source-control',
      sourceControlGroupOrder: GROUP_ORDER,
      sourceControlRef: { current: null },
      sourceControlViewMode: 'list',
      worktreeMap: new Map(),
      worktreePath: '/repo'
    }
    let renders = 0
    const { result, rerender, unmount } = renderHook(
      (input: typeof props) => {
        renders++
        return useSourceControlFileListing(input)
      },
      { initialProps: props }
    )
    function expectWork(keys: number, visits = 0) {
      expect([counters.branchKeys, counters.branchNodeVisits, counters.branchIngestions]).toEqual([
        keys,
        visits,
        keys
      ])
      counters.branchKeys = counters.branchNodeVisits = counters.branchIngestions = 0
    }
    function update(change: Partial<typeof props>) {
      props = { ...props, ...change }
      rerender(props)
    }
    const active = (index: number) =>
      expect([...result.current.activeOpenRowKeys]).toEqual([
        `branch::${branchEntries[index].path}`
      ])
    expectWork(count)
    active(0)
    rerender(props)
    update({ branchName: 'irrelevant display update' })
    expectWork(0)
    const settledRenders = renders
    act(() =>
      editorStore.setState({
        activeFileIdByWorktree: {
          ...editorStore.getState().activeFileIdByWorktree,
          'other-host-worktree': 'unrelated'
        }
      })
    )
    expect(renders).toBe(settledRenders)
    expectWork(0)
    act(() => editorStore.setState({ activeFileIdByWorktree: { 'wt-1': 'file-1' } }))
    expect(renders).toBeGreaterThan(settledRenders)
    active(1)
    expectWork(0)
    update({ filterQuery: 'match' })
    expectWork(count / 2)
    expect(result.current.activeOpenRowKeys.size).toBe(0)
    update({ collapsedSections: new Set(['branch']) })
    expectWork(0)
    update({ filterQuery: '' })
    expectWork(0)
    update({ collapsedSections: NO_COLLAPSED_SECTIONS })
    expectWork(count)
    active(1)
    update({ sourceControlViewMode: 'tree' })
    expectWork(count, count + 3)
    rerender(props)
    expectWork(0)
    update({ collapsedTreeDirs: new Set(['dir::branch::src/other']) })
    expectWork(count / 2, count / 2 + 3)
    expect(result.current.activeOpenRowKeys.size).toBe(0)
    update({ collapsedTreeDirs: NO_COLLAPSED_TREE_DIRS })
    expectWork(count, count + 3)
    active(1)
    update({ filterQuery: 'match' })
    expectWork(count / 2, count / 2 + 1)
    update({ collapsedSections: new Set(['branch']) })
    expectWork(0)
    update({ filterQuery: '' })
    expectWork(0)
    update({ collapsedSections: NO_COLLAPSED_SECTIONS })
    expectWork(count, count + 3)
    active(1)
    unmount()
  })
})
