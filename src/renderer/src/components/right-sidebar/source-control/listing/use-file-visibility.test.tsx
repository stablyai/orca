// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { useSourceControlFileProjection } from './use-file-projection'

afterEach(cleanup)

const entries: GitStatusEntry[] = [
  { path: 'src/app.ts', area: 'staged', status: 'modified' },
  { path: 'src/app.ts', area: 'unstaged', status: 'modified' },
  { path: 'src/app.snap', area: 'unstaged', status: 'modified' },
  { path: 'README.md', area: 'untracked', status: 'untracked' }
]
const base: Parameters<typeof useSourceControlFileProjection>[0] = {
  entries,
  branchEntries: [
    { path: 'src/app.ts', status: 'modified' },
    { path: 'docs/guide.md', status: 'added' }
  ],
  filterQuery: '',
  sourceControlGroupOrder: ['unstaged', 'staged', 'untracked'],
  activeWorktreeId: 'wt',
  worktreePath: '/repo',
  isFolder: false,
  collapsedTreeDirs: new Set(),
  expandedSubmoduleKeys: new Set(),
  submoduleStatusByKey: {},
  sourceControlViewMode: 'list',
  collapsedSections: new Set(),
  fileGroups: [{ name: 'Snapshots', patterns: ['**/*.snap'] }]
}

describe('source control visibility projection', () => {
  it.each(['list', 'tree'] as const)(
    'filters %s rows while keeping complete action targets',
    (mode) => {
      const { result } = renderHook(() =>
        useSourceControlFileProjection({
          ...base,
          sourceControlViewMode: mode,
          excludedExtensions: new Set(['.md']),
          hiddenFileGroups: new Set(['Snapshots'])
        })
      )
      expect(result.current.hiddenFileCount).toBe(3)
      expect(result.current.extensionCounts).toEqual([
        { extension: '.md', count: 2 },
        { extension: '.snap', count: 1 },
        { extension: '.ts', count: 1 }
      ])
      expect(result.current.filteredGrouped.unstaged.map((entry) => entry.path)).toEqual([
        'src/app.ts'
      ])
      expect(result.current.filteredGrouped.untracked).toEqual([])
      expect(result.current.filteredBranchEntries.map((entry) => entry.path)).toEqual([
        'src/app.ts'
      ])
      expect(result.current.grouped.unstaged).toHaveLength(2)
      expect(result.current.grouped.untracked).toHaveLength(1)
      expect(result.current.unfilteredDisplaySectionsById.get('unstaged')?.items).toHaveLength(2)
      expect(result.current.isGitHistoryVisible).toBe(true)
      expect(
        result.current.visibleSelectionEntries.every((entry) => entry.entry.path === 'src/app.ts')
      ).toBe(true)
    }
  )

  it('counts a path only once when it appears in staged, unstaged and committed changes', () => {
    const { result } = renderHook(() =>
      useSourceControlFileProjection({
        ...base,
        excludedExtensions: new Set(['.ts'])
      })
    )
    expect(result.current.hiddenFileCount).toBe(1)
  })

  it('preserves all underlying changes when every extension is hidden and restores on reset', () => {
    const { result, rerender } = renderHook(useSourceControlFileProjection, {
      initialProps: { ...base, excludedExtensions: new Set(['.md', '.ts', '.snap']) }
    })
    expect(result.current.displaySections).toEqual([])
    expect(result.current.filteredBranchEntries).toEqual([])
    expect(result.current.hiddenFileCount).toBe(4)
    expect(Object.values(result.current.grouped).flat()).toHaveLength(entries.length)
    rerender({ ...base, excludedExtensions: new Set() })
    expect(result.current.hiddenFileCount).toBe(0)
    expect(result.current.hasFileVisibilityFilter).toBe(false)
  })

  it('drops a removed preset without keeping a phantom active filter', () => {
    const { result } = renderHook(() =>
      useSourceControlFileProjection({
        ...base,
        fileGroups: [],
        hiddenFileGroups: new Set(['Snapshots'])
      })
    )
    expect(result.current.hiddenFileCount).toBe(0)
    expect(result.current.hasFileVisibilityFilter).toBe(false)
    expect(result.current.isGitHistoryVisible).toBe(true)
  })

  it.each([
    { excludedExtensions: new Set(['.absent']) },
    {
      hiddenFileGroups: new Set(['Generated']),
      fileGroups: [{ name: 'Generated', patterns: ['generated/**'] }]
    }
  ])('preserves history when a selected filter hides no paths', (selection) => {
    const { result } = renderHook(() => useSourceControlFileProjection({ ...base, ...selection }))
    expect(result.current.hasFileVisibilityFilter).toBe(true)
    expect(result.current.hiddenFileCount).toBe(0)
    expect(result.current.isGitHistoryVisible).toBe(true)
    expect(Object.values(result.current.filteredGrouped).flat()).toHaveLength(entries.length)
  })
})
