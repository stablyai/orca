import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as ResolveOwnerModule from '@/lib/resolve-owner'
import type * as RuntimeRpcClientModule from './runtime-rpc-client'
import type * as FrameDrawnModule from './web-session-tabs-sync/frame-drawn-server-workspaces'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import {
  _resetLayoutFramePositionForTests,
  beginLayoutFramePositions,
  noteLayoutFramePosition
} from './layout-frame-position'
import { recordLayoutApply, sendLayoutApply, type WindowLayoutCommand } from './layout-apply-send'
import { recordTabOrderInLayoutOwner } from '@/store/slices/tabs/tab-order-layout-owner'
import { mainLayoutFrameSender } from './main-loaded-layout-frames.test-fixture'
import { SERVER_ROUTED_LAYOUT_COMMANDS, serverLayoutApplyFor } from './server-layout-apply'
import { redrawServerLayoutWorkspace } from './server-layout-apply-routes'
import {
  CAPABLE,
  ENV,
  HOST_GROUP,
  LEAF_ID,
  SECOND_LEAF_ID,
  WT,
  createFakeLayoutStreams,
  createServerHarness,
  senderSnapshot,
  serverLayout,
  serverTerminalTab,
  settle,
  type TestStore
} from './server-layout-frames.test-fixture'
import { resetFrameDrawnServerWorkspacesForTests } from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { resetMirroredTerminalHandlesForTests } from './web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

type Subscribe = (...args: never[]) => { close: () => void }
type Sent = { target: RuntimeClientTarget; params: unknown }
const hoisted = vi.hoisted(
  (): {
    owners: Map<string, string>
    resync: Mock<(environmentId: string, worktreeId: string) => Promise<void>>
    subscribe: Subscribe | null
    sent: Sent[]
    reply: () => Promise<LayoutApplyReply>
  } => ({
    owners: new Map(),
    resync: vi.fn(),
    subscribe: null,
    sent: [],
    reply: async () => ({ ok: true, result: {} })
  })
)

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (...args: never[]) => hoisted.subscribe!(...args)
}))
vi.mock('./web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (_state: unknown, key: string) =>
    hoisted.owners.get(key) ?? null
}))
vi.mock('@/lib/resolve-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof ResolveOwnerModule>()),
  runtimeEnvironmentIdUnlessTwin: (_state: unknown, key: string) => hoisted.owners.get(key) ?? null
}))
vi.mock('./web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return {
    ...actual,
    callRuntimeRpc: (target: RuntimeClientTarget, method: string, params?: unknown) => {
      if (method !== 'layout.apply') {
        return actual.callRuntimeRpc(target, method, params)
      }
      hoisted.sent.push({ target, params })
      return hoisted.reply()
    }
  }
})

createStoreSessionMockApi()

const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe

const TAB_1 = toWebTerminalSurfaceTabId('host-tab-1')
const TAB_2 = toWebTerminalSurfaceTabId('host-tab-2')
const THIRD_LEAF_ID = '33333333-3333-4333-8333-333333333333'
// The server's tab-bar ids differ from its terminals' ids: the join must not derive one from the other.
const TWO_TABS: PublishedWorkspaceLayout = (() => {
  const tabs = [
    { ...serverTerminalTab('host-tab-1', LEAF_ID, 'server-pty-1'), id: 'bar-1' },
    { ...serverTerminalTab('host-tab-2', SECOND_LEAF_ID, 'server-pty-2'), id: 'bar-2' }
  ]
  return { ...serverLayout(tabs), groups: [{ id: HOST_GROUP, tabIds: ['bar-1', 'bar-2'] }] }
})()

const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

async function drawnByServer(layout = TWO_TABS) {
  const store = mirroredStore()
  install(store)
  setServers(store, [CAPABLE])
  const stream = streams.openTo(ENV)
  const frames = mainLayoutFrameSender()
  streams.send(stream, senderSnapshot(frames, { [WT]: layout }, 1))
  await settle()
  return { store, stream, frames }
}

function send(store: TestStore, command: WindowLayoutCommand) {
  const handlers = { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn() }
  const taken = sendLayoutApply(store.getState(), WT, command, handlers)
  return { taken, handlers }
}

const orderOf = (store: TestStore) =>
  store.getState().groupsByWorktree[WT]?.find((group) => group.id === HOST_GROUP)?.tabOrder

beforeEach(() => {
  hoisted.owners.clear()
  hoisted.sent.length = 0
  hoisted.reply = async () => ({ ok: true, result: {} })
  hoisted.resync.mockReset().mockResolvedValue(undefined)
  streams.all.length = 0
  resetWebSessionTabsSyncTestState()
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(uninstallAll)

describe('a layout intent for a workspace a server’s frames draw', () => {
  it('goes to that server’s main under its ids, and shows once that server’s frame is in', async () => {
    const { store, stream, frames } = await drawnByServer()
    expect(orderOf(store)).toEqual([TAB_1, TAB_2])
    hoisted.reply = async () => ({ ok: true, result: { tabId: 'bar-2' }, frameSeq: 2 })
    // This window's own main is far ahead: its frames must not release a server's reply.
    beginLayoutFramePositions()
    noteLayoutFramePosition(50)

    const { taken, handlers } = send(store, {
      type: 'moveTab',
      tabId: TAB_2,
      toGroupId: HOST_GROUP,
      index: 0
    })
    await settle()

    expect(taken).toBe(true)
    expect(hoisted.sent).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: {
          command: {
            type: 'moveTab',
            tabId: 'bar-2',
            toGroupId: HOST_GROUP,
            index: 0,
            afterTabId: null,
            workspace: WT
          }
        }
      }
    ])
    expect(handlers.apply).not.toHaveBeenCalled()

    const moved = structuredClone(TWO_TABS)
    moved.groups[0]!.tabIds = ['bar-2', 'bar-1']
    streams.send(stream, frames.records(WT, moved))
    await settle()

    expect(orderOf(store)).toEqual([TAB_2, TAB_1])
    expect(handlers.apply).toHaveBeenCalledWith({ tabId: TAB_2 }, { framesKey: ENV, routed: true })
    expect(handlers.asToday).not.toHaveBeenCalled()
  })

  it('names a move’s anchor by the server’s id', async () => {
    const { store } = await drawnByServer()
    send(store, {
      type: 'moveTab',
      tabId: TAB_1,
      toGroupId: HOST_GROUP,
      index: 1,
      afterTabId: TAB_2
    })
    await settle()
    expect(hoisted.sent[0]!.params).toMatchObject({
      command: { tabId: 'bar-1', afterTabId: 'bar-2', index: 1 }
    })
  })

  it('never sends raw an anchor the server does not hold when no drawn order places it', async () => {
    await drawnByServer()
    const move = { type: 'moveTab', tabId: TAB_1, toGroupId: HOST_GROUP, index: 1 } as const
    expect(serverLayoutApplyFor(ENV, WT, { ...move, afterTabId: 'desktop-only' })?.command).toEqual(
      { ...move, tabId: 'bar-1' }
    )
  })

  it('sends a new editor open under the proposed tab id and group, the server’s file id, no desktop owner', async () => {
    const { store } = await drawnByServer()
    const filePath = '/worktree/src/a.ts'
    hoisted.reply = async () => ({ ok: true, result: { tabId: 'proposed-tab' } })

    const { taken, handlers } = send(store, {
      type: 'openEditorTab',
      tabId: 'proposed-tab',
      fileId: ownedEditorFileId(filePath, WT, ENV),
      contentType: 'editor',
      file: {
        filePath,
        relativePath: 'src/a.ts',
        language: 'typescript',
        runtimeEnvironmentId: ENV
      },
      groupId: HOST_GROUP,
      preview: true
    })
    await settle()

    expect(taken).toBe(true)
    expect(hoisted.sent).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: {
          command: {
            type: 'openEditorTab',
            tabId: 'proposed-tab',
            fileId: ownedEditorFileId(filePath, WT, undefined),
            contentType: 'editor',
            file: { filePath, relativePath: 'src/a.ts', language: 'typescript' },
            groupId: HOST_GROUP,
            preview: true,
            workspace: WT
          }
        }
      }
    ])
    expect(handlers.apply).toHaveBeenCalledWith(
      { tabId: 'proposed-tab' },
      { framesKey: ENV, routed: true }
    )
  })

  // A window's close tells main the window already stopped its terminals, which this desktop cannot
  // do for a server's; closes, starts, sleeps and terminal names keep the RPCs that main applies.
  it('keeps today’s path for closes, starts, sleeps and a terminal’s own name', async () => {
    const { store } = await drawnByServer()
    const offList: WindowLayoutCommand[] = [
      { type: 'renamePane', tabId: TAB_1, leafId: LEAF_ID, title: 'x' },
      { type: 'closeTabs', tabIds: [TAB_1] },
      { type: 'closeTabs', tabIds: [TAB_1], recordClose: 'user' },
      { type: 'closePane', tabId: TAB_1, leafId: LEAF_ID },
      { type: 'splitPane', tabId: TAB_1, leafId: LEAF_ID, direction: 'vertical' },
      { type: 'createTerminalTab', tabId: TAB_1, leafId: LEAF_ID },
      { type: 'sleep', tabId: TAB_1, paneKeys: [], records: [] },
      { type: 'wake', tabId: TAB_1, paneKeys: ['k'] },
      { type: 'renameTab', tabId: TAB_1, kind: 'custom', title: 'named' },
      // A desktop's guess that the launched agent exited never clears the server's relaunch record.
      { type: 'setTabProps', tabId: TAB_1, clearLaunchAgent: true }
    ]
    for (const command of offList) {
      expect(send(store, command).taken).toBe(false)
    }
    for (const type of ['closeTabs', 'closePane', 'splitPane', 'createTerminalTab', 'sleep']) {
      expect(SERVER_ROUTED_LAYOUT_COMMANDS).not.toContain(type)
    }
    await settle()
    expect(hoisted.sent).toEqual([])
  })

  it.each<{ name: string; command: WindowLayoutCommand; sent: Record<string, unknown> }>([
    {
      name: 'a tab’s color',
      command: { type: 'setTabProps', tabId: TAB_2, color: '#ff0000' },
      sent: { type: 'setTabProps', tabId: 'bar-2', color: '#ff0000' }
    },
    {
      name: 'a tab’s pin',
      command: { type: 'setTabProps', tabId: TAB_1, isPinned: true },
      sent: { type: 'setTabProps', tabId: 'bar-1', isPinned: true }
    },
    {
      name: 'a tab’s chat pane',
      command: { type: 'setChatPane', tabId: TAB_1, leafId: LEAF_ID },
      sent: { type: 'setChatPane', tabId: 'bar-1', leafId: LEAF_ID }
    },
    {
      name: 'an AI vault title',
      command: { type: 'renameTab', tabId: TAB_2, kind: 'aiVault', title: null },
      sent: { type: 'renameTab', tabId: 'bar-2', kind: 'aiVault', title: null }
    },
    {
      name: 'the workspace’s default-tabs mark',
      command: { type: 'setDefaultTabsApplied' },
      sent: { type: 'setDefaultTabsApplied' }
    }
  ])('takes $name to the server’s main, which applies it as from its own window', async (each) => {
    const { store } = await drawnByServer()
    const { taken, handlers } = send(store, each.command)
    await settle()
    expect(taken).toBe(true)
    expect(handlers.asToday).not.toHaveBeenCalled()
    expect(hoisted.sent).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { command: { ...each.sent, workspace: WT } }
      }
    ])
  })

  // A drag-out on a server workspace must reach that server's main, or its frames snap the pane back.
  it('takes a pane dragged into a new tab to the server’s main, naming no desktop terminal', async () => {
    const { store } = await drawnByServer()
    hoisted.reply = async () => ({ ok: true, result: { tabId: 'bar-2', ptyId: 'server-pty-2' } })
    const { taken, handlers } = send(store, {
      type: 'movePaneToNewTab',
      tabId: TAB_1,
      leafId: LEAF_ID,
      groupId: HOST_GROUP,
      index: 1,
      windowDetach: { ptyId: 'remote:desktop-pty', startupCwd: '/srv/wt' }
    })
    await settle()

    expect(taken).toBe(true)
    expect(hoisted.sent).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: {
          command: {
            type: 'movePaneToNewTab',
            tabId: 'bar-1',
            leafId: LEAF_ID,
            groupId: HOST_GROUP,
            index: 1,
            windowDetach: { ptyId: null, startupCwd: '/srv/wt' },
            workspace: WT
          }
        }
      }
    ])
    expect(handlers.apply).toHaveBeenCalledWith(
      { tabId: TAB_2, ptyId: 'server-pty-2' },
      { framesKey: ENV, routed: true }
    )
    expect(handlers.asToday).not.toHaveBeenCalled()
  })

  it('keeps today’s path for a tab the server’s frames do not hold', async () => {
    const { store } = await drawnByServer()
    const command = { type: 'equalizePanes', tabId: 'web-terminal-unknown' } as const
    expect(send(store, command).taken).toBe(false)
    expect(hoisted.sent).toEqual([])
  })

  it.each([
    { reply: { ok: false, code: 'host_not_owned' } as const, code: 'host_not_owned' },
    { reply: { ok: false, code: 'tab_not_found' } as const, code: 'tab_not_found' },
    { reply: new Error('connection lost'), code: 'call_failed' }
  ])(
    'redraws from the server’s frames on $code, applies nothing here, and sends it once',
    async ({ reply, code }) => {
      const { store, stream, frames } = await drawnByServer()
      hoisted.reply = async () => {
        if (reply instanceof Error) {
          throw reply
        }
        return reply
      }
      // The window drew the move itself meanwhile; the server does not take it.
      const { taken, handlers } = send(store, {
        type: 'moveTab',
        tabId: TAB_2,
        toGroupId: HOST_GROUP,
        index: 0
      })
      store.setState({
        groupsByWorktree: {
          ...store.getState().groupsByWorktree,
          [WT]: (store.getState().groupsByWorktree[WT] ?? []).map((group) => ({
            ...group,
            tabOrder: [TAB_2, TAB_1]
          }))
        }
      })
      await settle()
      await settle()

      expect(taken).toBe(true)
      expect(handlers.refused).toHaveBeenCalledWith(code)
      expect(handlers.apply).not.toHaveBeenCalled()
      expect(handlers.asToday).not.toHaveBeenCalled()
      expect(orderOf(store)).toEqual([TAB_1, TAB_2])

      // A reconnect does not send it again: the server may have applied it.
      stream.onStatus({ state: 'lost' })
      stream.onStatus({ state: 'connecting' })
      streams.send(stream, senderSnapshot(frames, { [WT]: TWO_TABS }, 1))
      await settle()
      expect(hoisted.sent).toHaveLength(1)
    }
  )

  it('keeps today’s path once the server’s stream stops, and for a server without layout intents', async () => {
    const { store, stream } = await drawnByServer()
    stream.onStatus({ state: 'lost' })
    await settle()
    expect(send(store, { type: 'equalizePanes', tabId: TAB_1 }).taken).toBe(false)

    uninstallAll()
    const older = mirroredStore()
    install(older)
    setServers(older, [{ ...CAPABLE, capable: false }])
    expect(streams.of(ENV).filter((open) => !open.closed)).toHaveLength(0)
    const today: WindowLayoutCommand[] = [
      { type: 'equalizePanes', tabId: TAB_1 },
      { type: 'setTabProps', tabId: TAB_1, color: '#ff0000' },
      { type: 'setChatPane', tabId: TAB_1, leafId: LEAF_ID },
      { type: 'renameTab', tabId: TAB_1, kind: 'aiVault', title: null },
      { type: 'moveTab', tabId: TAB_1, toGroupId: HOST_GROUP, index: 1 },
      {
        type: 'movePaneToNewTab',
        tabId: TAB_1,
        leafId: LEAF_ID,
        groupId: HOST_GROUP,
        windowDetach: { ptyId: null }
      },
      { type: 'setDefaultTabsApplied' }
    ]
    for (const command of today) {
      expect(send(older, command).taken).toBe(false)
    }
    expect(hoisted.sent).toEqual([])
  })

  // A desktop close the server refuses (a pinned tab): the window dropped it, the frames bring it back.
  it('draws a tab the window closed again when its close is refused', async () => {
    const { store } = await drawnByServer()
    store.setState({
      groupsByWorktree: {
        ...store.getState().groupsByWorktree,
        [WT]: (store.getState().groupsByWorktree[WT] ?? []).map((group) => ({
          ...group,
          tabOrder: [TAB_2]
        }))
      },
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [WT]: (store.getState().tabsByWorktree[WT] ?? []).filter((tab) => tab.id !== TAB_1)
      }
    })
    expect(orderOf(store)).toEqual([TAB_2])

    expect(redrawServerLayoutWorkspace(ENV, WT)).toBe(true)
    await settle()

    expect(orderOf(store)).toEqual([TAB_1, TAB_2])
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toContain(TAB_1)
    expect(redrawServerLayoutWorkspace(ENV, 'repo::/elsewhere')).toBe(false)
  })

  it('lets a reply waiting on a server whose stream closes show at once', async () => {
    const { store } = await drawnByServer()
    hoisted.reply = async () => ({ ok: true, result: {}, frameSeq: 9 })
    const { handlers } = send(store, { type: 'equalizePanes', tabId: TAB_1 })
    await settle()
    expect(handlers.apply).not.toHaveBeenCalled()

    uninstallAll()
    await settle()
    expect(handlers.apply).toHaveBeenCalledTimes(1)
  })
})

describe('a move routed to a server among tabs this desktop holds alone', () => {
  const TAB_3 = toWebTerminalSurfaceTabId('host-tab-3')
  const THREE_TABS: PublishedWorkspaceLayout = (() => {
    const tabs = [
      { ...serverTerminalTab('host-tab-1', LEAF_ID, 'server-pty-1'), id: 'bar-1' },
      { ...serverTerminalTab('host-tab-2', SECOND_LEAF_ID, 'server-pty-2'), id: 'bar-2' },
      { ...serverTerminalTab('host-tab-3', THIRD_LEAF_ID, 'server-pty-3'), id: 'bar-3' }
    ]
    return {
      ...serverLayout(tabs),
      groups: [{ id: HOST_GROUP, tabIds: ['bar-1', 'bar-3', 'bar-2'] }]
    }
  })()

  /** Draws `order` in the server's group, with rows for the ids the server's frames lack. */
  function drawOrder(store: TestStore, order: string[]): void {
    const rows = store.getState().unifiedTabsByWorktree[WT]!
    const extra = order
      .filter((id) => !rows.some((tab) => tab.id === id))
      .map((id) => ({ ...rows[0]!, id, entityId: id }))
    store.setState({
      unifiedTabsByWorktree: { [WT]: [...rows, ...extra] },
      groupsByWorktree: {
        [WT]: store
          .getState()
          .groupsByWorktree[WT]!.map((group) =>
            group.id === HOST_GROUP ? { ...group, tabOrder: order } : group
          )
      }
    })
  }

  const sentCommand = (at: number) => hoisted.sent[at]!.params

  it('anchors a reopened tab after desktop tabs on the server tab before them', async () => {
    const { store } = await drawnByServer(THREE_TABS)
    // [S1, D1, D2, T, S2]: the server's [S1, S2] takes T between them.
    drawOrder(store, [TAB_1, 'd1', 'd2', TAB_3, TAB_2])
    recordLayoutApply(store.getState(), WT, {
      type: 'moveTab',
      tabId: TAB_3,
      toGroupId: HOST_GROUP,
      index: 3,
      afterTabId: 'd2'
    })
    // An index-only move (an agent launch's) is placed the same way.
    recordLayoutApply(store.getState(), WT, {
      type: 'moveTab',
      tabId: TAB_3,
      toGroupId: HOST_GROUP,
      index: 3
    })
    await settle()
    for (const at of [0, 1]) {
      expect(sentCommand(at)).toMatchObject({
        command: { tabId: 'bar-3', index: 1, afterTabId: 'bar-1' }
      })
    }
  })

  it('places a reorder past desktop tabs among the server’s tabs only', async () => {
    const { store } = await drawnByServer()
    const from = [TAB_1, 'd1', 'd2', TAB_2]
    const to = ['d1', 'd2', TAB_1, TAB_2]
    drawOrder(store, to)
    recordTabOrderInLayoutOwner(store.getState(), HOST_GROUP, { worktreeId: WT, from, to })
    await settle()
    // The server's order [S1, S2] is unchanged: S1 stays first.
    expect(hoisted.sent).toHaveLength(1)
    expect(sentCommand(0)).toMatchObject({
      command: { tabId: 'bar-1', index: 0, afterTabId: null }
    })
  })

  it('anchors a drop after a desktop tab on the server tab before it', async () => {
    const { store } = await drawnByServer(THREE_TABS)
    drawOrder(store, [TAB_1, 'd1', TAB_3, TAB_2])
    send(store, {
      type: 'moveTab',
      tabId: TAB_2,
      toGroupId: HOST_GROUP,
      index: 2,
      afterTabId: 'd1'
    })
    await settle()
    expect(sentCommand(0)).toMatchObject({
      command: { tabId: 'bar-2', index: 1, afterTabId: 'bar-1' }
    })
  })
})
