// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import {
  getRenderedLineageChipKeys,
  resolveChildWorkspacesToggleGroupKey
} from './child-workspaces-toggle-target'
import { computeRenderedSidebarRows } from './rendered-sidebar-worktree-order'
import { useSidebarWorktreeSelection } from './worktree-list/navigation/use-selection'
import { getPinnedWorktreeDisplayPolicy } from './worktree-list/grouping/row-types'
import { setVisibleWorktreeIds, setVisibleWorktreeShortcutTargets } from './visible-worktrees'
import { repo, worktree } from './worktree-list-groups-test-fixtures'

const initialState = useAppStore.getInitialState()
const parent: Worktree = { ...worktree, id: 'parent', instanceId: 'parent-instance' }
const child: Worktree = { ...worktree, id: 'child', instanceId: 'child-instance' }
const edge: WorktreeLineage = {
  worktreeId: child.id,
  worktreeInstanceId: 'child-instance',
  parentWorktreeId: parent.id,
  parentWorktreeInstanceId: 'parent-instance',
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 1
}
type HoverDocument = NonNullable<Parameters<typeof resolveChildWorkspacesToggleGroupKey>[2]>
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the no-hover fixture supplies only the empty NodeList methods the identity reader uses.
const noHover = {
  querySelectorAll: () => ({ length: 0, item: () => null })
} as unknown as HoverDocument

function seed(overrides: Partial<AppState> = {}): AppState {
  useAppStore.setState(
    {
      ...initialState,
      repos: [repo],
      worktreesByRepo: { [repo.id]: [parent, child] },
      worktreeLineageById: { [child.id]: edge },
      activeWorktreeId: parent.id,
      showSleepingWorkspaces: true,
      filterRepoIds: [],
      groupBy: 'none',
      ...overrides
    },
    true
  )
  return useAppStore.getState()
}

function target(state: AppState): string | null {
  return resolveChildWorkspacesToggleGroupKey(state, getRenderedLineageChipKeys(state), noHover)
}

describe('child workspace shortcut follows canonical rendered chips', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
    setVisibleWorktreeIds(null)
    setVisibleWorktreeShortcutTargets(null)
  })

  it('uses the mounted rows when a temporary reveal overrides a project filter', () => {
    const state = seed({ filterRepoIds: ['another-project'] })
    const sectionRows = computeRenderedSidebarRows(state, [parent, child])
    const hook = renderHook(() =>
      useSidebarWorktreeSelection({
        sectionRows,
        pinnedDisplayPolicy: getPinnedWorktreeDisplayPolicy(state.settings)
      })
    )
    try {
      expect(target(state)).toBe('lineage:parent')
    } finally {
      hook.unmount()
    }
  })

  it('does not flip hidden state while a mounted host drag removes the cards', () => {
    const state = seed()
    const hook = renderHook(() =>
      useSidebarWorktreeSelection({
        sectionRows: [],
        pinnedDisplayPolicy: getPinnedWorktreeDisplayPolicy(state.settings)
      })
    )
    try {
      expect(target(state)).toBeNull()
    } finally {
      hook.unmount()
    }
  })

  it('keeps the parent chip available when its children are folded', () => {
    const state = seed({ collapsedGroups: new Set(['lineage:parent']), activeWorktreeId: child.id })
    expect(target(state)).toBe('lineage:parent')
    expect(getRenderedLineageChipKeys(state)).toEqual(new Set(['lineage:parent']))
  })

  it('does not toggle a family hidden by a collapsed section', () => {
    expect(target(seed({ collapsedGroups: new Set(['all']) }))).toBeNull()
  })

  it('does not toggle a family excluded by the project filter', () => {
    expect(target(seed({ filterRepoIds: ['another-project'] }))).toBeNull()
  })

  it('does not invent a chip when all children are sleeping and filtered out', () => {
    const state = seed({
      worktreesByRepo: {
        [repo.id]: [{ ...parent, isMainWorktree: true, branch: 'refs/heads/main' }, child]
      },
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: true
    })
    expect(target(state)).toBeNull()
    expect(getRenderedLineageChipKeys(state)).toEqual(new Set())
  })

  it('drops archived children and stale child or parent instances', () => {
    for (const worktrees of [
      [parent, { ...child, isArchived: true }],
      [parent, { ...child, instanceId: 'new-child' }],
      [{ ...parent, instanceId: 'new-parent' }, child]
    ]) {
      expect(target(seed({ worktreesByRepo: { [repo.id]: worktrees } }))).toBeNull()
    }
  })

  it('uses one persisted key when pinning duplicates the parent card', () => {
    const pinnedParent = { ...parent, isPinned: true }
    const state = seed({
      worktreesByRepo: { [repo.id]: [pinnedParent, child] },
      settings: createGlobalSettingsFixture({ showPinnedWorktreesInGroups: true })
    })
    const chips = computeRenderedSidebarRows(state, [pinnedParent, child]).filter(
      (row) => row.type === 'item' && row.lineageGroupKey === 'lineage:parent'
    )
    expect(chips).toHaveLength(2)
    expect(getRenderedLineageChipKeys(state)).toEqual(new Set(['lineage:parent']))
    expect(target(state)).toBe('lineage:parent')
  })
})
