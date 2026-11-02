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

  // #11800: the host's close record is the identity a ghost row needs; without it the row stayed forever.
  it('retires a kept row once the host publishes a close record for every pane it holds', () => {
    const closed = restoredRow('restored-a', 0)
    const open = restoredRow('restored-b', 1)
    const split = restoredRow('restored-c', 2)
    const {
      pendingActivationSpawn: _spawn,
      restoredFromSession: _restored,
      ...base
    } = restoredRow('client-d', 3)
    const clientMinted: TerminalTab = { ...base, ptyId: 'remote:web-env-1@@gone-d' }
    const unbound = restoredRow('restored-e', 4)
    const revived: TerminalTab = { ...base, id: 'client-g', ptyId: 'remote:web-env-1@@gone-g' }
    const retired = (parentTabId: string, leafId: string, terminal: string) => ({
      parentTabId,
      leafId,
      terminal,
      ptyId: `host-${terminal}`
    })

    const patch: Partial<WebSessionTabsSyncState> = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [closed, open, split, clientMinted, unbound, revived] },
        terminalLayoutsByTabId: {
          [closed.id]: restoredLayout(SECOND_LEAF_ID, 'remote:web-env-1@@gone-a'),
          [open.id]: restoredLayout(THIRD_LEAF_ID, 'remote:web-env-1@@gone-b'),
          [split.id]: {
            root: {
              type: 'split' as const,
              direction: 'vertical' as const,
              first: { type: 'leaf' as const, leafId: SECOND_LEAF_ID },
              second: { type: 'leaf' as const, leafId: THIRD_LEAF_ID }
            },
            activeLeafId: SECOND_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: {
              [SECOND_LEAF_ID]: 'remote:web-env-1@@gone-c1',
              [THIRD_LEAF_ID]: 'remote:web-env-1@@gone-c2'
            }
          },
          [revived.id]: {
            root: {
              type: 'split' as const,
              direction: 'vertical' as const,
              first: { type: 'leaf' as const, leafId: SECOND_LEAF_ID },
              second: { type: 'leaf' as const, leafId: THIRD_LEAF_ID }
            },
            activeLeafId: SECOND_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: {
              [SECOND_LEAF_ID]: 'remote:web-env-1@@gone-g',
              [THIRD_LEAF_ID]: 'remote:web-env-1@@revived-h'
            }
          }
        }
      }),
      makeSnapshot(
        [
          unrelatedReadySurface,
          // A handle survives its PTY's re-incarnation, so a live one outranks an older close record.
          {
            ...unrelatedReadySurface,
            id: 'host-surface-h',
            parentTabId: 'host-tab-h',
            isActive: false,
            terminal: 'revived-h'
          }
        ],
        {
          retiredTerminalSurfaces: [
            retired(closed.id, SECOND_LEAF_ID, 'gone-a'),
            retired(split.id, SECOND_LEAF_ID, 'gone-c1'),
            retired('host-tab-d', LEAF_ID, 'gone-d'),
            retired(unbound.id, LEAF_ID, 'gone-e'),
            retired('host-tab-g', SECOND_LEAF_ID, 'gone-g'),
            retired('host-tab-g', THIRD_LEAF_ID, 'revived-h')
          ]
        }
      ),
      ENV,
      NOW
    )

    const ids = patch.tabsByWorktree?.[WT]?.map((tab) => tab.id) ?? []
    expect(ids).not.toContain(closed.id)
    expect(ids).not.toContain(clientMinted.id)
    expect(ids).not.toContain(unbound.id)
    expect(ids).toContain(revived.id)
    expect(ids).toContain(open.id)
    expect(ids).toContain(split.id)
  })
})
