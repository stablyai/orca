import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  THIRD_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))

/**
 * #25339: rows restored from the saved session carry `pendingActivationSpawn` until their pane
 * mounts. Any ready host terminal used to retire every one of them, unrelated or not.
 */
function restoredRow(id: string, sortOrder: number): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WT,
    title: `Restored ${id}`,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: NOW - 10,
    pendingActivationSpawn: true,
    restoredFromSession: true
  }
}

function restoredLayout(leafId: string, ptyId: string) {
  return {
    root: { type: 'leaf' as const, leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

const unrelatedReadySurface = {
  type: 'terminal' as const,
  id: HOST_SURFACE_ID,
  title: 'host shell',
  parentTabId: 'host-tab-1',
  leafId: LEAF_ID,
  isActive: true,
  status: 'ready' as const,
  terminal: 'terminal-1'
}

describe('restored placeholders retire only by their own identity', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps two restored rows when the host publishes an unrelated terminal', () => {
    const first = restoredRow('restored-a', 0)
    const second = restoredRow('restored-b', 1)

    const patch: Partial<WebSessionTabsSyncState> = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [first, second] },
        terminalLayoutsByTabId: {
          [first.id]: restoredLayout(SECOND_LEAF_ID, 'remote:web-env-1@@gone-a'),
          [second.id]: restoredLayout(THIRD_LEAF_ID, 'remote:web-env-1@@gone-b')
        }
      }),
      makeSnapshot([unrelatedReadySurface]),
      ENV,
      NOW
    )

    const ids = patch.tabsByWorktree?.[WT]?.map((tab) => tab.id) ?? []
    expect(ids).toContain(first.id)
    expect(ids).toContain(second.id)
    expect(ids).toHaveLength(3)
  })

  it('retires a restored row once the host publishes the PTY it was bound to', () => {
    const restored = restoredRow('restored-a', 0)

    const patch: Partial<WebSessionTabsSyncState> = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [restored] },
        terminalLayoutsByTabId: {
          [restored.id]: restoredLayout(SECOND_LEAF_ID, 'remote:web-env-1@@terminal-1')
        }
      }),
      makeSnapshot([unrelatedReadySurface]),
      ENV,
      NOW
    )

    expect(patch.tabsByWorktree?.[WT]?.map((tab) => tab.id)).not.toContain(restored.id)
    expect(patch.tabsByWorktree?.[WT]).toHaveLength(1)
  })
})
