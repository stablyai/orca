import { describe, expect, it, vi } from 'vitest'
import {
  buildMobileSessionTabSnapshots,
  focusRuntimeTerminalSurface,
  hasRegisteredRuntimeTerminalTab,
  registerRuntimeTerminalTab
} from './sync-runtime-graph'
import { makeState } from './sync-runtime-graph-test-harness'
import type { AppState } from '../store/types'

const TAB_ID = 'duplicate-tab'
const WORKTREE_A = 'registry-worktree-a'
const WORKTREE_B = 'registry-worktree-b'
const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function registerSurface(worktreeId: string, leafId: string, ptyId: string): () => void {
  const pane = { id: 1, leafId }
  const manager = {
    getPanes: () => [pane],
    getActivePane: () => pane,
    getLeafId: (paneId: number) => (paneId === pane.id ? pane.leafId : null),
    getNumericIdForLeaf: (candidateLeafId: string) =>
      candidateLeafId === pane.leafId ? pane.id : null
  }
  return registerRuntimeTerminalTab({
    tabId: TAB_ID,
    worktreeId,
    getManager: () => manager as never,
    getContainer: () => null,
    getPtyIdForPane: (paneId) => (paneId === pane.id ? ptyId : null),
    getTabWideAgentHintLeafId: () => null
  })
}

function duplicateTabState(): AppState {
  return makeState({
    tabsByWorktree: {
      [WORKTREE_A]: [{ id: TAB_ID, worktreeId: WORKTREE_A, title: 'A', ptyId: 'pty-a' }],
      [WORKTREE_B]: [{ id: TAB_ID, worktreeId: WORKTREE_B, title: 'B', ptyId: 'pty-b' }]
    } as unknown as AppState['tabsByWorktree'],
    // The persisted layout map is legacy tab-id keyed. Mounted captures must
    // still remain isolated by their worktree registration.
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_A },
        activeLeafId: LEAF_A,
        expandedLeafId: null
      }
    } as unknown as AppState['terminalLayoutsByTabId']
  })
}

describe('runtime terminal registration ownership', () => {
  it('keeps duplicate tab ids scoped to their registered worktree', () => {
    const unregisterA = registerSurface(WORKTREE_A, LEAF_A, 'pty-a')
    const unregisterB = registerSurface(WORKTREE_B, LEAF_B, 'pty-b')
    try {
      expect(hasRegisteredRuntimeTerminalTab(TAB_ID)).toBe(false)
      expect(hasRegisteredRuntimeTerminalTab(TAB_ID, WORKTREE_A)).toBe(true)
      expect(hasRegisteredRuntimeTerminalTab(TAB_ID, WORKTREE_B)).toBe(true)

      const snapshots = buildMobileSessionTabSnapshots(duplicateTabState())
      const terminalFor = (worktreeId: string) =>
        snapshots
          .find((snapshot) => snapshot.worktree === worktreeId)
          ?.tabs.find((tab) => tab.type === 'terminal')

      // Legacy layout/title maps are tab-id keyed, so publishing either row
      // would risk assigning one worktree's persisted metadata to the other.
      expect(terminalFor(WORKTREE_A)).toBeUndefined()
      expect(terminalFor(WORKTREE_B)).toBeUndefined()
    } finally {
      unregisterB()
      unregisterA()
    }
  })

  it('focuses the requested worktree when tab ids collide', () => {
    const focusA = vi.fn()
    const focusB = vi.fn()
    const paneA = { id: 1, leafId: LEAF_A, terminal: { focus: focusA } }
    const paneB = { id: 1, leafId: LEAF_B, terminal: { focus: focusB } }
    const managerA = {
      getPanes: () => [paneA],
      getActivePane: () => paneA,
      getLeafId: () => LEAF_A,
      getNumericIdForLeaf: () => 1
    }
    const managerB = {
      getPanes: () => [paneB],
      getActivePane: () => paneB,
      getLeafId: () => LEAF_B,
      getNumericIdForLeaf: () => 1
    }
    const unregisterA = registerRuntimeTerminalTab({
      tabId: TAB_ID,
      worktreeId: WORKTREE_A,
      getManager: () => managerA as never,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    const unregisterB = registerRuntimeTerminalTab({
      tabId: TAB_ID,
      worktreeId: WORKTREE_B,
      getManager: () => managerB as never,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    try {
      expect(focusRuntimeTerminalSurface(TAB_ID, null, WORKTREE_B)).toBe(true)
      expect(focusB).toHaveBeenCalledOnce()
      expect(focusA).not.toHaveBeenCalled()
      expect(focusRuntimeTerminalSurface(TAB_ID)).toBe(false)
    } finally {
      unregisterB()
      unregisterA()
    }
  })
})
