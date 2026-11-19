import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { toWebTerminalSurfaceTabId } from '../../../../../../shared/workspace-layout/terminal-surface-id'
import type { TerminalLayoutSnapshot } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import {
  createStore,
  LEAF_1,
  LEAF_2,
  SOURCE_TAB_ID,
  TARGET_GROUP_ID,
  WORKTREE_ID
} from './terminal-pane-tab-detach-fixture'
import type { TerminalPaneTabDetachStore } from './terminal-pane-tab-detach'

const hostMove = vi.hoisted(() => ({
  route: { kind: 'window' } as
    | { kind: 'host'; environmentId: string }
    | { kind: 'window' }
    | { kind: 'unavailable' },
  outcome: 'moved' as 'moved' | 'refused' | 'unknown',
  settle: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/hosted-terminals/actions/web-runtime-leaf-move', () => ({
  resolvePaneMoveHost: vi.fn(async () => hostMove.route),
  moveWebRuntimeLeafToNewTab: vi.fn(async () => hostMove.outcome),
  settleHostPaneMove: hostMove.settle
}))
vi.mock('@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-move', () => ({
  resolveHostTabDropTarget: vi.fn(async (_env: string, args: { targetGroupId: string }) => ({
    targetGroupId: args.targetGroupId
  }))
}))
vi.mock('@/store/terminals/retirement/terminal-surface-close-intent', () => ({
  commitTerminalSurfaceClose: vi.fn()
}))

const { detachTerminalPaneToTab } = await import('./terminal-pane-tab-detach')

const HOST_SOURCE_TAB_ID = toWebTerminalSurfaceTabId('host-tab::host-leaf')

function titledLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_1 },
      second: { type: 'leaf', leafId: LEAF_2 }
    },
    activeLeafId: LEAF_2,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_1]: 'pty-left', [LEAF_2]: 'pty-right' },
    titlesByLeafId: { [LEAF_2]: 'build-watch' }
  }
}

function manager() {
  const panes = [{ id: 1 }, { id: 2 }]
  return {
    getPanes: () => panes,
    getLeafId: (paneId: number) => (paneId === 1 ? LEAF_1 : paneId === 2 ? LEAF_2 : null),
    detachPaneForExternalMove: vi.fn(() => true)
  }
}

function storeFor(sourceTabId: string, layout: TerminalLayoutSnapshot): TerminalPaneTabDetachStore {
  const store = createStore(layout)
  store.terminalLayoutsByTabId[sourceTabId] = layout
  Object.assign(store, { setTabCustomTitle: vi.fn() })
  return store
}

function detach(
  store: TerminalPaneTabDetachStore,
  sourceTabId: string,
  extra: { targetTabId?: string } = {}
) {
  return detachTerminalPaneToTab({
    livePtyId: 'pty-right',
    getStore: () => store,
    manager: manager(),
    persistLayoutSnapshot: vi.fn(),
    sourcePaneId: 2,
    sourceTabId,
    targetGroupId: TARGET_GROUP_ID,
    worktreeId: WORKTREE_ID,
    ...extra
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  hostMove.route = { kind: 'window' }
  hostMove.outcome = 'moved'
  Object.assign(window, {
    api: {
      pty: {
        moveLeafToNewTab: vi.fn(async () => ({ status: 'moved', ptyId: 'pty-right' }))
      }
    }
  })
})

describe('moving a pane to a new tab', () => {
  it('names the new tab after the pane it carries', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())

    const moved = await detach(store, SOURCE_TAB_ID)

    expect(moved?.ptyId).toBe('pty-right')
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('tab-detached', 'build-watch', {
      recordInteraction: false
    })
  })

  it('leaves naming to the client that asked for the move', async () => {
    const store = storeFor(SOURCE_TAB_ID, titledLayout())

    await detach(store, SOURCE_TAB_ID, { targetTabId: 'tab-detached' })

    expect(store.setTabCustomTitle).not.toHaveBeenCalled()
  })

  it('refuses up front when the host owning the tab cannot take the move', async () => {
    hostMove.route = { kind: 'unavailable' }
    const store = storeFor(HOST_SOURCE_TAB_ID, titledLayout())

    const moved = await detach(store, HOST_SOURCE_TAB_ID)

    expect(moved).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(window.api.pty.moveLeafToNewTab).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('tells the user when the host refuses a move it already drew', async () => {
    hostMove.route = { kind: 'host', environmentId: 'env-1' }
    hostMove.outcome = 'refused'
    const store = storeFor(HOST_SOURCE_TAB_ID, titledLayout())

    const moved = await detach(store, HOST_SOURCE_TAB_ID)
    await vi.waitFor(() => expect(hostMove.settle).toHaveBeenCalled())

    expect(moved).not.toBeNull()
    const [, , outcome, movedHere, onRefused] = hostMove.settle.mock.calls[0]
    expect([outcome, movedHere]).toEqual(['refused', true])
    onRefused()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
