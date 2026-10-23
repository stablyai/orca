import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'
import { moveLeafThroughLayoutOwner } from './terminal-pane-detach-layout-owner'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'
import {
  createStore,
  LEAF_1,
  LEAF_2,
  SOURCE_TAB_ID,
  TARGET_GROUP_ID,
  WORKTREE_ID
} from './terminal-pane-tab-detach-fixture'
import { LOCAL_LAYOUT_APPLY_ORIGIN } from '@/runtime/server-layout-apply-routes'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => ({
  send: vi.fn<typeof sendLayoutCommandToOwner>(),
  toastError: vi.fn()
}))
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/layout-owner-command', () => ({ sendLayoutCommandToOwner: mocks.send }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const legacyMove = vi.fn<(request: TerminalLeafMoveRequest) => Promise<TerminalLeafMoveResult>>()
const request: TerminalLeafMoveRequest = {
  worktreeId: WORKTREE_ID,
  sourceTabId: SOURCE_TAB_ID,
  targetTabId: 'tab-window',
  leafId: LEAF_2,
  ptyId: 'pty-right'
}
const lastHandlers = () => mocks.send.mock.calls.at(-1)![2]

beforeEach(() => {
  mocks.send.mockReset()
  mocks.send.mockReturnValue(true)
  mocks.toastError.mockClear()
  legacyMove.mockReset()
  legacyMove.mockResolvedValue({ status: 'not_held' })
  vi.stubGlobal('window', {
    api: { pty: { moveLeafToNewTab: legacyMove }, session: { closeTerminalSurface: vi.fn() } }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('moveLeafThroughLayoutOwner', () => {
  afterEach(() => useAppStore.setState({ terminalLayoutsByTabId: {} }))

  it('sends the drag-out with the window’s terminal and answers with main’s tab', async () => {
    const moving = moveLeafThroughLayoutOwner(request, { groupId: TARGET_GROUP_ID, index: 1 })

    expect(mocks.send).toHaveBeenCalledWith(
      WORKTREE_ID,
      {
        type: 'movePaneToNewTab',
        tabId: SOURCE_TAB_ID,
        leafId: LEAF_2,
        groupId: TARGET_GROUP_ID,
        index: 1,
        windowDetach: { ptyId: 'pty-right' }
      },
      expect.anything()
    )
    lastHandlers().apply({ tabId: 'tab-main', ptyId: 'pty-right' }, LOCAL_LAYOUT_APPLY_ORIGIN)
    await expect(moving).resolves.toEqual({
      status: 'moved',
      ptyId: 'pty-right',
      tabId: 'tab-main'
    })
    expect(legacyMove).not.toHaveBeenCalled()
  })

  it('keeps the desktop’s terminal id when a paired server’s main moved the pane', async () => {
    const routed = { framesKey: 'env-1', routed: true }
    const moving = moveLeafThroughLayoutOwner(request, { groupId: TARGET_GROUP_ID, index: 1 })
    lastHandlers().apply({ tabId: 'tab-server', ptyId: 'server-pty-9' }, routed)
    // The server's own id is never a binding here.
    await expect(moving).resolves.toEqual({
      status: 'moved',
      ptyId: 'pty-right',
      tabId: 'tab-server'
    })

    const unbound = moveLeafThroughLayoutOwner(
      { ...request, ptyId: null },
      { groupId: TARGET_GROUP_ID, index: undefined }
    )
    lastHandlers().apply({ tabId: 'tab-server', ptyId: 'server-pty-new' }, routed)
    await expect(unbound).resolves.toEqual({ status: 'moved', ptyId: null, tabId: 'tab-server' })
    expect(legacyMove).not.toHaveBeenCalled()
  })

  it('binds the moved pane to the terminal the server’s frame drew, not a stale one', async () => {
    // The server respawned the pane's shell; its frame drew the new tab with the new handle.
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-server': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_2]: 'remote-new' }
        }
      }
    })
    const moving = moveLeafThroughLayoutOwner(request, { groupId: TARGET_GROUP_ID, index: 1 })
    lastHandlers().apply(
      { tabId: 'tab-server', ptyId: 'server-pty-new' },
      { framesKey: 'env-1', routed: true }
    )

    await expect(moving).resolves.toEqual({
      status: 'moved',
      ptyId: 'remote-new',
      tabId: 'tab-server'
    })
  })

  it('moves as today when main lacks the pane, or a paired server owns the workspace', async () => {
    const lacking = moveLeafThroughLayoutOwner(request, {
      groupId: TARGET_GROUP_ID,
      index: undefined
    })
    lastHandlers().asToday()
    await expect(lacking).resolves.toEqual({ status: 'not_held' })

    mocks.send.mockReturnValue(false)
    await moveLeafThroughLayoutOwner(request, { groupId: TARGET_GROUP_ID, index: undefined })
    expect(legacyMove).toHaveBeenCalledTimes(2)
    expect(legacyMove).toHaveBeenCalledWith(request)
  })

  it('reports main’s refusal as the move’s', async () => {
    const moving = moveLeafThroughLayoutOwner(request, {
      groupId: TARGET_GROUP_ID,
      index: undefined
    })
    lastHandlers().refused!('pty_mismatch')
    await expect(moving).resolves.toEqual({ status: 'refused', reason: 'pty_mismatch' })
  })
})

describe('detachTerminalPaneToTab in a layout-owner build', () => {
  function detach(store: ReturnType<typeof createStore>) {
    return detachTerminalPaneToTab({
      getStore: () => store,
      manager: {
        getPanes: () => [{ id: 1 }, { id: 2 }],
        getLeafId: (paneId: number) => (paneId === 2 ? LEAF_2 : LEAF_1),
        detachPaneForExternalMove: () => true
      },
      persistLayoutSnapshot: vi.fn(),
      sourcePaneId: 2,
      sourceTabId: SOURCE_TAB_ID,
      targetGroupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID
    })
  }

  it('opens the new tab under main’s id', async () => {
    const store = createStore()
    mocks.send.mockImplementation((_worktreeId, _command, handlers) => {
      handlers.apply({ tabId: 'tab-main', ptyId: 'pty-right' }, LOCAL_LAYOUT_APPLY_ORIGIN)
      return true
    })

    await expect(detach(store)).resolves.toMatchObject({ leafId: LEAF_2, ptyId: 'pty-right' })

    expect(store.createTab).toHaveBeenCalledWith(
      WORKTREE_ID,
      TARGET_GROUP_ID,
      'powershell.exe',
      expect.objectContaining({ id: 'tab-main', initialLeafId: LEAF_2 })
    )
    expect(legacyMove).not.toHaveBeenCalled()
  })

  it('keeps the pane and says so when main refuses', async () => {
    const store = createStore()
    mocks.send.mockImplementation((_worktreeId, _command, handlers) => {
      handlers.refused?.('pane_in_other_tab')
      return true
    })

    await expect(detach(store)).resolves.toBeNull()

    expect(store.createTab).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledOnce()
  })
})
