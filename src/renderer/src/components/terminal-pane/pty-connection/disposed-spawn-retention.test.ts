import { describe, expect, it } from 'vitest'
import { composeWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../../shared/terminal-tab-types'
import type { WorktreeDeleteState } from '@/store/slices/worktree-delete-state-types'
import { shouldRetainDisposedPaneSpawn } from './disposed-spawn-retention'

const WT = 'wt'
const TAB = 'tab-a'
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WT,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function layout(leafId: string): TerminalLayoutSnapshot {
  return { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
}

function state(overrides: {
  tabs?: Record<string, TerminalTab[]>
  layouts?: Record<string, TerminalLayoutSnapshot>
  deleting?: Record<string, WorktreeDeleteState>
}) {
  return {
    tabsByWorktree: overrides.tabs ?? { [WT]: [tab(TAB)] },
    terminalLayoutsByTabId: overrides.layouts ?? {},
    deleteStateByWorktreeId: overrides.deleting ?? {}
  }
}

const deleting: WorktreeDeleteState = {
  isDeleting: true,
  error: null,
  canForceDelete: false,
  forceDeleteReason: null
}

describe('shouldRetainDisposedPaneSpawn', () => {
  it('keeps the PTY for a tab that still exists and has no layout root yet', () => {
    expect(shouldRetainDisposedPaneSpawn(state({}), WT, TAB, LEAF)).toBe(true)
  })

  it('keeps the PTY when the layout still names the leaf', () => {
    expect(
      shouldRetainDisposedPaneSpawn(state({ layouts: { [TAB]: layout(LEAF) } }), WT, TAB, LEAF)
    ).toBe(true)
  })

  it('kills the PTY when the tab is gone from every worktree', () => {
    expect(
      shouldRetainDisposedPaneSpawn(state({ tabs: { [WT]: [tab('other-tab')] } }), WT, TAB, LEAF)
    ).toBe(false)
  })

  it('kills the PTY when the leaf was removed from the layout', () => {
    expect(
      shouldRetainDisposedPaneSpawn(
        state({ layouts: { [TAB]: layout(OTHER_LEAF) } }),
        WT,
        TAB,
        LEAF
      )
    ).toBe(false)
  })

  it('kills the PTY when its worktree is being deleted even though the tab is still listed', () => {
    expect(
      shouldRetainDisposedPaneSpawn(state({ deleting: { [WT]: deleting } }), WT, TAB, LEAF)
    ).toBe(false)
    expect(
      shouldRetainDisposedPaneSpawn(state({ deleting: { other: deleting } }), WT, TAB, LEAF)
    ).toBe(true)
  })

  it.each(['local', 'ssh:target', 'runtime:paired'] as const)(
    'retires a disposed spawn when its %s workspace is being deleted',
    (executionHostId) => {
      const deletingState = state({
        deleting: { [composeWorktreeHostIdentity(executionHostId, WT)]: deleting }
      })

      expect(shouldRetainDisposedPaneSpawn(deletingState, WT, TAB, LEAF, executionHostId)).toBe(
        false
      )
      expect(shouldRetainDisposedPaneSpawn(deletingState, WT, TAB, LEAF, 'ssh:other-target')).toBe(
        true
      )
    }
  )

  it('keeps legacy deletion entries scoped to their recorded execution host', () => {
    const deletingState = state({
      deleting: { [WT]: { ...deleting, executionHostId: 'ssh:target' } }
    })

    expect(shouldRetainDisposedPaneSpawn(deletingState, WT, TAB, LEAF, 'ssh:target')).toBe(false)
    expect(shouldRetainDisposedPaneSpawn(deletingState, WT, TAB, LEAF, 'ssh:other-target')).toBe(
      true
    )
    expect(
      shouldRetainDisposedPaneSpawn(state({ deleting: { [WT]: deleting } }), WT, TAB, LEAF, 'local')
    ).toBe(false)
  })

  it('finds the tab under a worktree other than the one it was opened in', () => {
    expect(
      shouldRetainDisposedPaneSpawn(state({ tabs: { [WT]: [], other: [tab(TAB)] } }), WT, TAB, LEAF)
    ).toBe(true)
  })
})
