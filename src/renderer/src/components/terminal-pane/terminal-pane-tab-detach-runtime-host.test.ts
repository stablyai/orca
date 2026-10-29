import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'
import {
  createStore,
  LEAF_2,
  SOURCE_TAB_ID,
  TARGET_GROUP_ID,
  WORKTREE_ID
} from './terminal-pane-tab-detach-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from '../../../../shared/terminal-surface-id'
const moveOnHost = vi.hoisted(() => vi.fn())
const paneMoveHost = vi.hoisted(() => vi.fn())
const moveLocally = vi.hoisted(() => vi.fn())
const settle = vi.hoisted(() => vi.fn())
const dropTarget = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/web-runtime-leaf-move', () => ({
  moveWebRuntimeLeafToNewTab: moveOnHost,
  resolvePaneMoveHost: paneMoveHost,
  settleHostPaneMove: settle
}))
vi.mock('@/runtime/web-runtime-session-tab-move', () => ({
  resolveHostTabDropTarget: dropTarget
}))
const MIRRORED_SOURCE = toWebTerminalSurfaceTabId('host-source')
const HOST_PLACEMENT = { targetGroupId: 'host-group', index: 0 }
const itSwitchOff = it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)
function mirroredStore(layoutOf = SOURCE_TAB_ID) {
  const store = createStore()
  store.terminalLayoutsByTabId[MIRRORED_SOURCE] = store.terminalLayoutsByTabId[layoutOf]!
  return store
}
function detach(store: ReturnType<typeof createStore>, targetIndex?: number) {
  const detachPaneForExternalMove = vi.fn(() => true)
  const result = detachTerminalPaneToTab({
    getStore: () => store,
    manager: {
      getPanes: () => [{ id: 1 }, { id: 2 }],
      getLeafId: () => LEAF_2,
      detachPaneForExternalMove
    },
    persistLayoutSnapshot: vi.fn(),
    sourcePaneId: 2,
    sourceTabId: MIRRORED_SOURCE,
    targetGroupId: TARGET_GROUP_ID,
    ...(targetIndex === undefined ? {} : { targetIndex }),
    worktreeId: WORKTREE_ID
  })
  return { result, detachPaneForExternalMove }
}
describe('detachTerminalPaneToTab on a runtime-hosted worktree', () => {
  beforeEach(() => {
    moveOnHost.mockReset()
    settle.mockReset().mockResolvedValue(undefined)
    dropTarget.mockReset().mockResolvedValue(HOST_PLACEMENT)
    paneMoveHost.mockReset().mockResolvedValue('env-1')
    moveLocally.mockReset().mockResolvedValue({ status: 'not_held' })
    vi.stubGlobal('window', { api: { pty: { moveLeafToNewTab: moveLocally } } })
  })
  itSwitchOff('moves locally before the host answers, under the host target tab id', async () => {
    let answer: (value: unknown) => void = () => {}
    moveOnHost.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const store = mirroredStore()
    const { result, detachPaneForExternalMove } = detach(store)
    const detached = await result
    // The host has not answered yet, and the window already holds the moved pane.
    expect(detachPaneForExternalMove).toHaveBeenCalledOnce()
    const [environmentId, request, placement] = moveOnHost.mock.calls[0]
    expect(environmentId).toBe('env-1')
    expect(placement).toBe(HOST_PLACEMENT)
    expect(request.sourceTabId).toBe(MIRRORED_SOURCE)
    expect(toWebTerminalSurfaceTabId(toHostSessionTabId(request.targetTabId))).toBe(
      request.targetTabId
    )
    expect(vi.mocked(store.createTab).mock.calls[0][3]).toMatchObject({
      id: request.targetTabId,
      mirroredHostTab: true
    })
    expect(detached?.tab.id).toBe('tab-detached')
    expect(moveLocally).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    answer('moved')
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('env-1', request, 'moved', true))
  })
  itSwitchOff('names the drop to the host in its own group ids', async () => {
    moveOnHost.mockReturnValue(new Promise(() => {}))
    await detach(mirroredStore(), 0).result
    expect(dropTarget).toHaveBeenCalledWith('env-1', {
      worktreeId: WORKTREE_ID,
      tabId: expect.any(String),
      targetGroupId: TARGET_GROUP_ID,
      index: 0
    })
  })
  itSwitchOff('settles a refusal of a move this window drew', async () => {
    moveOnHost.mockResolvedValue('refused')
    const store = mirroredStore()
    const { result, detachPaneForExternalMove } = detach(store)
    await result
    expect(moveOnHost).toHaveBeenCalledOnce()
    await vi.waitFor(() =>
      expect(settle).toHaveBeenCalledWith('env-1', moveOnHost.mock.calls[0][1], 'refused', true)
    )
    expect(store.createTab).toHaveBeenCalledOnce()
    expect(detachPaneForExternalMove).toHaveBeenCalledOnce()
    expect(store.closeTab).not.toHaveBeenCalled()
  })
  itSwitchOff(
    'moves only in this window under a local id when the host predates the RPC',
    async () => {
      paneMoveHost.mockResolvedValue(null)
      const store = mirroredStore()
      const { result } = detach(store)
      await result
      expect(moveOnHost).not.toHaveBeenCalled()
      const request = moveLocally.mock.calls[0][0]
      expect(isWebTerminalSurfaceTabId(request.targetTabId)).toBe(false)
      expect(vi.mocked(store.createTab).mock.calls[0][3]).not.toHaveProperty('mirroredHostTab')
    }
  )
})
