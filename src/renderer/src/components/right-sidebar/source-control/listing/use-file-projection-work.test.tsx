// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
const { useSourceControlFileProjection } = await import('./use-file-projection')
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

describe('useSourceControlFileProjection view-mode gating', () => {
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
})
