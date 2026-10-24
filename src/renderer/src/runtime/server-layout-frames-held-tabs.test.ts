import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as ResolveOwnerModule from '@/lib/resolve-owner'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import type * as RuntimeRpcClientModule from './runtime-rpc-client'
import type * as FrameDrawnModule from './web-session-tabs-sync/frame-drawn-server-workspaces'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  PublishedTab,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  DESKTOP_CREATED_SERVER_TAB_HOLDS,
  _reloadDesktopCreatedServerTabsForTests,
  _resetDesktopCreatedServerTabsForTests,
  noteDesktopCreatedServerTab
} from '@/lib/desktop-created-server-tabs'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { _resetLayoutFramePositionForTests } from './layout-frame-position'
import { useAppStore } from '@/store'
import { stageWebRuntimeBrowserTab } from './web-runtime-browser-tab-staging'
import {
  _resetStagedBrowserFrameHandoversForTests,
  wasStagedBrowserTabHandedToFrames
} from '@/lib/staged-browser-frame-handover'
import { ensureSimulatorTab } from '@/lib/ensure-simulator-tab'
import type { DragEndEvent } from '@dnd-kit/core'
import { commitTabDragDrop } from '@/components/tab-group/tab-drag-drop-commit'
import {
  canMoveTabToNewPaneColumn,
  moveTabToNewPaneColumn
} from '@/components/tab-bar/tab-move-to-pane-column'
import { resolvePanelEdgePaneColumnSplit } from '@/components/tab-group/tab-group-panel-split-target'
import { mainLayoutFrameSender } from './main-loaded-layout-frames.test-fixture'
import {
  CAPABLE,
  ENV,
  HOST_GROUP,
  LEAF_ID,
  SECOND_LEAF_ID,
  SERVER_LAYOUT,
  WT,
  createFakeLayoutStreams,
  createServerHarness,
  mirrorSnapshot,
  senderSnapshot,
  serverLayout,
  serverTerminalTab,
  sessionTabs,
  settle,
  surface,
  type TestStore
} from './server-layout-frames.test-fixture'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { resetFrameDrawnServerWorkspacesForTests } from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { resetMirroredTerminalHandlesForTests } from './web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

type Subscribe = (...args: never[]) => { close: () => void }
type Sent = { method: string; params: unknown }
const hoisted = vi.hoisted(
  (): {
    owners: Map<string, string>
    resync: Mock<(environmentId: string, worktreeId: string) => Promise<void>>
    subscribe: Subscribe | null
    sent: Sent[]
  } => ({ owners: new Map(), resync: vi.fn(), subscribe: null, sent: [] })
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
vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRuntimeOwnerModule>()),
  runtimeEnvironmentIdOrLocalUnlessTwin: (_state: unknown, key: string) =>
    hoisted.owners.get(key) ?? null
}))
vi.mock('./web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))
// Every RPC this window sends, whichever client sends it.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return {
    ...actual,
    callRuntimeRpc: (_target: RuntimeClientTarget, method: string, params?: unknown) => {
      hoisted.sent.push({ method, params })
      // A call that fails releases what it held: no hold outlives its test.
      return Promise.reject(new Error('not connected'))
    }
  }
})

/** This desktop's localStorage, which outlives a reload. */
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key)
})

const api = createStoreSessionMockApi()
const environmentCall = vi.fn((args: { method: string; params?: unknown }) => {
  hoisted.sent.push({ method: args.method, params: args.params })
  return Promise.resolve({
    id: 'test',
    ok: false as const,
    error: { code: 'not_connected', message: 'not connected' }
  })
})
Object.assign(api.runtimeEnvironments, { call: environmentCall })

const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe

const TAB_1 = toWebTerminalSurfaceTabId('host-tab-1')
const TAB_2 = toWebTerminalSurfaceTabId('host-tab-2')
const GROUP_2 = 'host-group-2'
const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

/** The server's layout once it opened a second terminal tab: a records frame that rebuilds WT. */
const WITH_TAB_2 = serverLayout([
  serverTerminalTab('host-tab-1', LEAF_ID, 'server-pty-1'),
  serverTerminalTab('host-tab-2', SECOND_LEAF_ID, 'server-pty-2', 2)
])

/** The server's two groups, split by another client: `first` holds tab 1, `second` tab 2. */
function serverSplit(
  first = HOST_GROUP,
  second = GROUP_2,
  ratio?: number
): PublishedWorkspaceLayout {
  return {
    ...WITH_TAB_2,
    groups: [
      { id: first, tabIds: ['host-tab-1'] },
      { id: second, tabIds: ['host-tab-2'] }
    ],
    groupLayout: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: first },
      second: { type: 'leaf', groupId: second },
      ...(ratio === undefined ? {} : { ratio })
    }
  }
}

const tabIds = (store: TestStore) =>
  (store.getState().unifiedTabsByWorktree[WT] ?? []).map((tab) => tab.id)
const groups = (store: TestStore) =>
  (store.getState().groupsByWorktree[WT] ?? []).map((group) => group.tabOrder)
const groupIds = (store: TestStore) =>
  (store.getState().groupsByWorktree[WT] ?? []).map((group) => group.id)
/** The app store as it loads: tests that drive app-store paths start from it. */
const APP_STORE_AT_LOAD = useAppStore.getState()

/** As frameDrawnStore, on the app store, which the staging and drag paths write. */
async function appStoreFrameDrawn(layout = SERVER_LAYOUT) {
  const store = useAppStore
  hoisted.owners.set(WT, ENV)
  mirrorSnapshot(store, ENV, sessionTabs([surface('host-tab-1', LEAF_ID, 'terminal-1')], 1))
  install(store)
  setServers(store, [CAPABLE])
  const stream = streams.openTo(ENV)
  const frames = mainLayoutFrameSender()
  streams.send(stream, senderSnapshot(frames, { [WT]: SERVER_LAYOUT }, 1))
  if (layout !== SERVER_LAYOUT) {
    streams.send(stream, frames.records(WT, layout))
  }
  await settle()
  return { store, stream, frames }
}

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  useAppStore.setState(APP_STORE_AT_LOAD, true)
  hoisted.owners.clear()
  hoisted.resync.mockReset().mockResolvedValue(undefined)
  hoisted.sent.length = 0
  streams.all.length = 0
  resetWebSessionTabsSyncTestState()
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
  storage.clear()
  _resetDesktopCreatedServerTabsForTests()
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  uninstallAll()
  check.uninstall()
  expect(check.failures).toEqual([])
})

/** A client-hosted browser tab staged as the create path stages it: this desktop's alone. */
function stageHeld(groupId = HOST_GROUP) {
  const staged = stageWebRuntimeBrowserTab({
    environmentId: ENV,
    worktreeId: WT,
    remotePageId: 'client-page-1',
    activate: true,
    clientHosted: true,
    targetGroupId: groupId
  })!
  expect(staged.tabId).toBeDefined()
  return { staged, held: staged.tabId! }
}

const groupOf = (store: TestStore, tabId: string) =>
  store.getState().unifiedTabsByWorktree[WT]?.find((tab) => tab.id === tabId)?.groupId
const shownIn = (store: TestStore, groupId: string) =>
  store.getState().groupsByWorktree[WT]?.find((group) => group.id === groupId)?.activeTabId
const mentions = (...ids: string[]) =>
  hoisted.sent.filter((call) => ids.some((id) => JSON.stringify(call.params ?? null).includes(id)))

/** A reload: streams, frame state and the in-memory record go; restored rows and storage stay. */
function reload(): void {
  uninstallAll()
  streams.all.length = 0
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
  _reloadDesktopCreatedServerTabsForTests()
}

async function firstFrameAfterReload(store: TestStore) {
  install(store)
  setServers(store, [{ ...CAPABLE, runtimeId: 'runtime-2' }])
  const stream = streams.openTo(ENV)
  streams.send(stream, senderSnapshot(mainLayoutFrameSender(), { [WT]: WITH_TAB_2 }, 1))
  await settle()
}

describe('a held tab in a server’s frame-drawn workspace', () => {
  it('keeps its tab, page and handle in its group position through a frame and a reconnect', async () => {
    const { store, stream, frames } = await appStoreFrameDrawn()
    const { staged, held } = stageHeld()
    const kept = () => {
      const state = store.getState()
      return {
        group: groupOf(store, held),
        order: state.groupsByWorktree[WT]?.find((group) => group.id === HOST_GROUP)?.tabOrder,
        page: state.browserPagesByWorkspace[staged.workspaceId]?.map((page) => page.id),
        handle: state.remoteBrowserPageHandlesByPageId[staged.pageId]
      }
    }
    const before = kept()
    expect(before.order).toEqual([TAB_1, held])

    streams.send(stream, frames.records(WT, WITH_TAB_2))
    await settle()
    // Presence: the frame's build ran and drew the server's new tab.
    expect(check.workspaceBuilt).toContain(WT)
    expect(kept()).toEqual({ ...before, order: [TAB_1, held, TAB_2] })
    stream.onStatus({ state: 'lost' })
    stream.onStatus({ state: 'connecting' })
    check.forgetBuilds()
    streams.send(stream, senderSnapshot(mainLayoutFrameSender(), { [WT]: WITH_TAB_2 }, 5))
    await settle()
    expect(check.fullBuilt).toContain(WT)
    expect(kept()).toEqual({ ...before, order: [TAB_1, held, TAB_2] })
    // Staging and the frames send nothing that names it.
    expect(mentions(staged.workspaceId, staged.pageId, held)).toEqual([])
  })

  it('opened to the side, shows as the user’s tab in the nearest server group, with the server’s tree', async () => {
    const { store, stream, frames } = await appStoreFrameDrawn(serverSplit())
    const serverTree = store.getState().layoutByWorktree[WT]
    const side = store.getState().createEmptySplitGroup(WT, GROUP_2, 'right', { activate: true })!
    const { held } = stageHeld(side)
    // Precondition: drawn in the window's own group, which the user is in.
    expect(groupOf(store, held)).toBe(side)
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(side)

    streams.send(stream, frames.records(WT, serverSplit(HOST_GROUP, GROUP_2, 0.7)))
    await settle()
    expect(groups(store)).toEqual([[TAB_1], [TAB_2, held]])
    expect(store.getState().layoutByWorktree[WT]).toEqual({ ...serverTree, ratio: 0.7 })
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(GROUP_2)
    expect(shownIn(store, GROUP_2)).toBe(held)
  })

  it('moves unshown when another client closes its group while the user is in another', async () => {
    const { store, stream, frames } = await appStoreFrameDrawn(serverSplit())
    const { held } = stageHeld(GROUP_2)
    store.getState().focusGroup(WT, HOST_GROUP)
    // Precondition: shown in the second group; the user is on tab 1 in the first.
    expect(shownIn(store, GROUP_2)).toBe(held)
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(HOST_GROUP)
    expect(shownIn(store, HOST_GROUP)).toBe(TAB_1)

    streams.send(stream, frames.records(WT, WITH_TAB_2))
    await settle()
    expect(groups(store)).toEqual([[TAB_1, held, TAB_2]])
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(HOST_GROUP)
    expect(shownIn(store, HOST_GROUP)).toBe(TAB_1)
  })

  it('is not moved by an unrelated server frame sent twice', async () => {
    const { store, stream, frames } = await appStoreFrameDrawn(serverSplit())
    const { held } = stageHeld(GROUP_2)
    const shown = { groups: groups(store), layout: store.getState().layoutByWorktree[WT] }
    const recoloured = serverSplit()
    recoloured.tabs[0] = { ...recoloured.tabs[0]!, color: '#ff0000' }
    for (const frame of [recoloured, recoloured]) {
      streams.send(stream, frames.records(WT, structuredClone(frame)))
      await settle()
      expect(groups(store)).toEqual(shown.groups)
      expect(store.getState().layoutByWorktree[WT]).toEqual(shown.layout)
      expect(groupOf(store, held)).toBe(GROUP_2)
    }
    // Presence: the frame reached the store.
    expect(store.getState().unifiedTabsByWorktree[WT]?.find((tab) => tab.id === TAB_1)?.color).toBe(
      '#ff0000'
    )
  })

  it('dragged to another group, moves here only: no RPC names it', async () => {
    const { store } = await appStoreFrameDrawn(serverSplit())
    const { staged, held } = stageHeld(HOST_GROUP)
    const finishDrag = vi.fn()
    commitTabDragDrop({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a drop with no pointer: the commit reads only active.data, its rect and over.data.
      event: {
        active: {
          id: held,
          data: {
            current: {
              kind: 'tab',
              worktreeId: WT,
              groupId: HOST_GROUP,
              unifiedTabId: held,
              visibleTabId: held,
              tabType: 'browser',
              label: 'Docs'
            }
          },
          rect: { current: { initial: null } }
        },
        over: {
          id: GROUP_2,
          data: { current: { kind: 'pane-body', worktreeId: WT, groupId: GROUP_2 } }
        }
      } as unknown as DragEndEvent,
      worktreeId: WT,
      dragGeometryRef: { current: null },
      dropUnifiedTab: store.getState().dropUnifiedTab,
      reorderUnifiedTabs: store.getState().reorderUnifiedTabs,
      finishDrag
    })
    await settle()
    // Presence: the drop ran and moved the tab here.
    expect(finishDrag).toHaveBeenCalled()
    expect(groupOf(store, held)).toBe(GROUP_2)
    expect(groupIds(store)).toEqual([HOST_GROUP, GROUP_2])
    expect(mentions(staged.workspaceId, held)).toEqual([])
  })
})

describe('a held tab and the split commands', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 600 }
  const rightEdge = { x: 990, y: 300 }
  const dragOf = (tabId: string, groupId: string) => ({
    kind: 'tab' as const,
    worktreeId: WT,
    groupId,
    unifiedTabId: tabId,
    visibleTabId: tabId,
    tabType: 'browser' as const,
    label: tabId
  })
  const edgeSplit = (store: TestStore, tabId: string, groupId: string, target: string) =>
    resolvePanelEdgePaneColumnSplit({
      activeDrag: dragOf(tabId, groupId),
      targetGroupId: target,
      worktreeId: WT,
      pointer: rightEdge,
      groupsByWorktree: store.getState().groupsByWorktree,
      layoutByWorktree: store.getState().layoutByWorktree,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the split target reads only the rect's edges.
      panelRect: rect as DOMRect,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      bodyRect: { ...rect, top: 40, height: 560 } as DOMRect
    })

  it('offers a held tab no new split, by drag or by the pane-column command', async () => {
    const { store } = await appStoreFrameDrawn(serverSplit())
    const { held } = stageHeld(HOST_GROUP)
    // Presence: the server's own tab gets the edge split in the same place.
    expect(edgeSplit(store, TAB_1, HOST_GROUP, GROUP_2)).toMatchObject({ zone: 'right' })

    expect(edgeSplit(store, held, HOST_GROUP, GROUP_2)).toBeNull()
    expect(canMoveTabToNewPaneColumn(held, HOST_GROUP)).toBe(false)
    expect(
      moveTabToNewPaneColumn({ unifiedTabId: held, groupId: HOST_GROUP, direction: 'right' })
    ).toBe(false)
    expect(groupIds(store)).toEqual([HOST_GROUP, GROUP_2])
  })

  it('counts only the server’s tabs: the server group’s one tab cannot split off its own group', async () => {
    const { store } = await appStoreFrameDrawn(serverSplit())
    stageHeld(HOST_GROUP)
    // Presence: the group holds two tabs here, one of them the server's.
    expect(groups(store)[0]).toHaveLength(2)

    expect(canMoveTabToNewPaneColumn(TAB_1, HOST_GROUP)).toBe(false)
    expect(edgeSplit(store, TAB_1, HOST_GROUP, HOST_GROUP)).toBeNull()
    expect(
      moveTabToNewPaneColumn({ unifiedTabId: TAB_1, groupId: HOST_GROUP, direction: 'right' })
    ).toBe(false)
    expect(mentions(TAB_1, 'host-tab-1')).toEqual([])
  })
})

describe('a simulator tab opened on this desktop in a server’s frame-drawn workspace', () => {
  it('opens as the user’s tab in the server group it would split beside, and is never sent', async () => {
    const { store } = await appStoreFrameDrawn(serverSplit())
    store.getState().focusGroup(WT, HOST_GROUP)

    const simulator = ensureSimulatorTab(WT, { targetGroupId: GROUP_2, placement: 'rightSplit' })!
    await settle()
    expect(groupIds(store)).toEqual([HOST_GROUP, GROUP_2])
    expect(groupOf(store, simulator)).toBe(GROUP_2)
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(GROUP_2)
    expect(shownIn(store, GROUP_2)).toBe(simulator)
    expect(mentions(simulator)).toEqual([])
  })

  it('survives the next server frame and a reload’s first frame', async () => {
    const { store, stream, frames } = await appStoreFrameDrawn()
    const simulator = ensureSimulatorTab(WT, { targetGroupId: HOST_GROUP })!
    expect(groups(store)).toEqual([[TAB_1, simulator]])

    streams.send(stream, frames.records(WT, WITH_TAB_2))
    await settle()
    // Presence: the frame's build ran and drew the server's new tab.
    expect(check.workspaceBuilt).toContain(WT)
    expect(groups(store)).toEqual([[TAB_1, simulator, TAB_2]])

    reload()
    await firstFrameAfterReload(store)
    expect(groups(store)).toEqual([[TAB_1, simulator, TAB_2]])
    expect(mentions(simulator)).toEqual([])
  })

  it('follows the server’s frames once the server publishes it: its close drops it here', async () => {
    const { store, stream, frames } = await appStoreFrameDrawn()
    const simulator = ensureSimulatorTab(WT, { targetGroupId: HOST_GROUP })!
    expect(DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld(WT, simulator)).toBe(true)
    const published: PublishedTab = {
      id: simulator,
      kind: 'simulator',
      entityId: simulator,
      executionHostId: 'local',
      createdAt: 3,
      customTitle: null,
      color: null
    }
    streams.send(stream, frames.records(WT, serverLayout([...SERVER_LAYOUT.tabs, published])))
    await settle()
    expect(DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld(WT, simulator)).toBe(false)

    streams.send(stream, frames.records(WT, WITH_TAB_2))
    await settle()
    expect(tabIds(store)).toEqual([TAB_1, TAB_2])
  })

  it('is recorded only while a server’s frames draw it: a mirrored server workspace records nothing', async () => {
    const store = useAppStore
    hoisted.owners.set(WT, ENV)
    mirrorSnapshot(store, ENV, sessionTabs([surface('host-tab-1', LEAF_ID, 'terminal-1')], 1))
    const before = groupIds(store)

    const simulator = ensureSimulatorTab(WT, { placement: 'rightSplit' })
    await settle()
    // Drawn here as today, in a split of its own: no server's frames draw this workspace.
    expect(simulator).toBeTruthy()
    expect(tabIds(store)).toContain(simulator)
    expect(groupIds(store)).toHaveLength(before.length + 1)
    expect(before).not.toContain(groupOf(store, simulator!))
    expect(DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld(WT, simulator!)).toBe(false)
    expect(storage.size).toBe(0)
  })
})

describe('a held tab across a window reload', () => {
  it('survives the first server frame after the reload', async () => {
    const { store } = await appStoreFrameDrawn()
    const { held } = stageHeld()
    expect(groups(store)).toEqual([[TAB_1, held]])

    reload()
    await firstFrameAfterReload(store)
    // Presence: the frame drew the server's new tab.
    expect(tabIds(store)).toContain(TAB_2)
    expect(groups(store)).toEqual([[TAB_1, held, TAB_2]])
  })

  it('forgets a recorded tab the restored session no longer has, so it never comes back', async () => {
    const { store } = await appStoreFrameDrawn()
    noteDesktopCreatedServerTab(ENV, WT, 'gone-tab')
    expect(DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld(WT, 'gone-tab')).toBe(true)

    reload()
    await firstFrameAfterReload(store)
    expect(DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld(WT, 'gone-tab')).toBe(false)
    expect([...storage.values()].join()).not.toContain('gone-tab')
    _reloadDesktopCreatedServerTabsForTests()
    expect(DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld(WT, 'gone-tab')).toBe(false)
  })
})

describe('a tab in this window’s own frame-drawn workspace', () => {
  it('shows as main’s frames have it: no desktop hold keeps it', async () => {
    const store = mirroredStore()
    hoisted.owners.clear()
    const sync = openWorkspaceLayoutFrameSync(store)
    const stream = streams.all.find((open) => open.target.kind === 'local' && !open.closed)!
    const frames = mainLayoutFrameSender()
    streams.send(stream, senderSnapshot(frames, { [WT]: SERVER_LAYOUT }, 1))
    sync.start()
    await settle()
    store
      .getState()
      .createUnifiedTab(WT, 'simulator', { id: 'emulator-1', targetGroupId: HOST_GROUP })
    noteDesktopCreatedServerTab(ENV, WT, 'emulator-1')

    streams.send(stream, frames.records(WT, WITH_TAB_2))
    await settle()
    expect(check.workspaceBuilt).toContain(WT)
    expect(tabIds(store)).not.toContain('emulator-1')
    sync.close()
  })
})

describe('a staged server-hosted browser tab (L285)', () => {
  /** The server's layout once it published the page: its own tab and record for it. */
  const WITH_PAGE = (() => {
    const layout = serverLayout([
      serverTerminalTab('host-tab-1', LEAF_ID, 'server-pty-1'),
      { ...serverTerminalTab('server-browser-tab', LEAF_ID, null, 2), kind: 'browser' as const }
    ])
    const browserTab = { ...layout.tabs[1]!, entityId: 'server-browser-1' }
    delete browserTab.terminal
    return {
      ...layout,
      tabs: [layout.tabs[0]!, browserTab],
      browserTabs: [{ id: 'server-browser-1', pageIds: ['server-page-1'] }]
    }
  })()

  it('stays through a frame that does not list its page, and hands over to the one that does', async () => {
    _resetStagedBrowserFrameHandoversForTests()
    const { store, stream, frames } = await appStoreFrameDrawn()
    const staged = stageWebRuntimeBrowserTab({
      environmentId: ENV,
      worktreeId: WT,
      remotePageId: 'server-page-1',
      activate: true,
      targetGroupId: HOST_GROUP
    })!

    // Another client's change rebuilds the workspace before the server publishes the page.
    streams.send(stream, frames.records(WT, WITH_TAB_2))
    await settle()
    expect(check.workspaceBuilt).toContain(WT)
    expect(tabIds(store)).toContain(staged.tabId)

    check.forgetBuilds()
    streams.send(stream, frames.records(WT, WITH_PAGE))
    await settle()
    expect(check.workspaceBuilt).toContain(WT)
    expect(tabIds(store)).not.toContain(staged.tabId)
    expect(tabIds(store)).toContain('server-browser-tab')
    expect(wasStagedBrowserTabHandedToFrames(staged.workspaceId, 'server-page-1')).toBe(true)
    expect(DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld(WT, staged.workspaceId)).toBe(false)
  })

  it('leaves no hold on a tab the mirror adopted before the frames drew the workspace', async () => {
    const { store, stream, frames } = await appStoreFrameDrawn()
    const staged = stageWebRuntimeBrowserTab({
      environmentId: ENV,
      worktreeId: WT,
      remotePageId: 'server-page-1',
      activate: true,
      targetGroupId: HOST_GROUP
    })!
    // The mirror's adoption: same rows, the handle no longer staged.
    store.getState().setRemoteBrowserPageHandle(staged.pageId, {
      environmentId: ENV,
      remotePageId: 'server-page-1'
    })

    streams.send(stream, frames.records(WT, WITH_PAGE))
    await settle()
    expect(check.workspaceBuilt).toContain(WT)
    expect(tabIds(store)).not.toContain(staged.tabId)
    expect(tabIds(store)).toContain('server-browser-tab')
    expect(DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld(WT, staged.tabId!)).toBe(false)
  })
})
