import { clearRuntimeCompatibilityCache } from '../../runtime/runtime-rpc-client'
import type * as RuntimeRpcModule from '../../runtime/runtime-rpc-client'
import type * as AppStoreModule from '../index'
// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { useTabGroupCreationCommands } from '../../components/tab-group/useTabGroupCreationCommands'
import { createWebRuntimeSessionTerminalResult } from '../../runtime/web-runtime-terminal-create-operation'
import { detachTerminalPaneToTab } from '../../components/terminal-pane/terminal-pane-tab-detach'
import {
  splitLayout,
  LEAF_1,
  LEAF_2
} from '../../components/terminal-pane/terminal-pane-tab-detach-fixture'
import { seed, O, D, frame } from './workspace-presentation-test-fixture'
import { rawWorkspaceState, workspaceSourceWrite } from '../workspace-source-state'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { applyWebSessionTabsSnapshot } from '../../runtime/web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSyncTestState } from '../../runtime/web-session-tabs-sync-test-harness'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { LAYOUT_INTENTS_RUNTIME_CAPABILITY } from '../../../../shared/workspace-layout/layout-intents-capability'
import { installServerLayoutFrames } from '../../runtime/server-layout-frames'
import {
  mainLoadedLayouts,
  mainLayoutFrameSender
} from '../../runtime/main-loaded-layout-frames.test-fixture'
import {
  createFakeLayoutStreams,
  serverTerminalTab
} from '../../runtime/server-layout-frames.test-fixture'
import { workspaceSourceSession } from '../workspace-source-state'
import type { subscribeRuntimeLayout } from '../../runtime/runtime-layout-client'
import { publicRuntimeEnvironment } from '../../runtime/paired-runtime-environment-test-fixture'
const holder = vi.hoisted((): { store?: StoreApi<AppState> } => ({}))
const capability = vi.hoisted(() => vi.fn(async () => false))
const layoutOwner = vi.hoisted(() => ({ main: false }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.main
  }
}))
const layoutTransport = vi.hoisted((): { subscribe?: typeof subscribeRuntimeLayout } => ({}))
vi.mock('../../runtime/runtime-layout-client', () => ({
  subscribeRuntimeLayout: (...args: Parameters<typeof subscribeRuntimeLayout>) =>
    layoutTransport.subscribe!(...args)
}))
vi.mock('@/store', async (original) => {
  const actual = await original<typeof AppStoreModule>()
  const { useStore } = await import('zustand')
  const current = () => {
    if (!holder.store) {
      throw new Error('missing store')
    }
    return holder.store
  }
  return {
    ...actual,
    useAppStore: Object.assign(
      <T,>(selector: (state: AppState) => T) => useStore(current(), selector),
      {
        getState: () => current().getState(),
        setState: (patch: Parameters<StoreApi<AppState>['setState']>[0]) =>
          current().setState(patch),
        subscribe: (listener: (state: AppState, previous: AppState) => void) =>
          current().subscribe(listener)
      }
    )
  }
})
vi.mock('../../runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpcModule>()),
  runtimeEnvironmentSupportsCapability: capability
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
const domWindow = window
const api = createStoreSessionMockApi()
const frameStops: (() => void)[] = []
Object.assign(domWindow, { api })
Object.assign(globalThis, { window: domWindow })
afterEach(() => {
  for (const stop of frameStops.splice(0)) {
    stop()
  }
  cleanup()
  vi.restoreAllMocks()
  resetWebSessionTabsSyncTestState()
  layoutOwner.main = false
})

async function framed(store: ReturnType<typeof seed>) {
  layoutOwner.main = true
  const streams = createFakeLayoutStreams()
  layoutTransport.subscribe = streams.subscribe
  const raw = rawWorkspaceState(store.getState())
  const layouts = mainLoadedLayouts('local', {
    ...getDefaultWorkspaceSession(),
    ...workspaceSourceSession(raw),
    browserTabsByWorktree: raw.browserTabsByWorktree
  })
  const status = store.getState().runtimeStatusByEnvironmentId.get('box')!
  store.setState({
    runtimeEnvironments: [
      publicRuntimeEnvironment({ id: 'box', runtimeId: 'box', pairingRevision: 1 })
    ],
    runtimeStatusByEnvironmentId: new Map([
      [
        'box',
        {
          ...status,
          status: {
            ...status.status!,
            capabilities: [BROWSER_SCREENCAST_RUNTIME_CAPABILITY, LAYOUT_INTENTS_RUNTIME_CAPABILITY]
          }
        }
      ]
    ])
  })
  const sender = mainLayoutFrameSender()
  return {
    layouts,
    start: async () => {
      frameStops.push(installServerLayoutFrames(store))
      streams.send(streams.openTo('box'), sender.snapshot(layouts, 1))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    },
    send: (workspace: string, layout: (typeof layouts)[string]) =>
      streams.send(streams.openTo('box'), sender.records(workspace, layout))
  }
}

function setup(main = false) {
  clearRuntimeCompatibilityCache()
  layoutOwner.main = main
  resetWebSessionTabsSyncTestState()
  const store = seed('runtime:box')
  holder.store = store
  store.setState({
    runtimeStatusByEnvironmentId: new Map([
      [
        'box',
        {
          checkedAt: 1,
          status: {
            runtimeId: 'box',
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: 1,
            liveTabCount: 2,
            liveLeafCount: 0,
            capabilities: [BROWSER_SCREENCAST_RUNTIME_CAPABILITY]
          }
        }
      ]
    ])
  })
  const groupId = store.getState().createEmptySplitGroup(D, 'left', 'right', { activate: false })!
  return { store, groupId }
}
function admit(store: ReturnType<typeof seed>, snapshot: RuntimeMobileSessionTabsResult) {
  store.setState((raw) =>
    workspaceSourceWrite(applyWebSessionTabsSnapshot(raw, snapshot, 'box', 1_700_000_000_000), {
      sources: [snapshot.worktree]
    })
  )
}
function browser(pageId: string): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'browser',
    id: `host-${pageId}`,
    browserWorkspaceId: `workspace-${pageId}`,
    browserPageId: pageId,
    browserProfileId: 'profile',
    title: 'Example',
    url: 'https://example.com/source',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }
}

it.each([
  [false, false],
  [true, false],
  [true, true]
])(
  'creates a shell through the real group menu and settles U (shell capability %s, host frames %s)',
  async (supported, hostFrames) => {
    const { store, groupId } = setup(hostFrames)
    const frames = hostFrames ? await framed(store) : undefined
    capability.mockResolvedValue(supported)
    const terminal = {
      type: 'terminal' as const,
      id: `terminal::${LEAF_1}`,
      parentTabId: 'terminal',
      leafId: LEAF_1,
      title: 'Shell',
      isActive: true,
      ptyId: 'term-1'
    }
    const snapshot = {
      ...frame(D, 'chat2', 3),
      tabs: [...frame(D, 'chat2', 3).tabs, terminal],
      activeTabId: terminal.id,
      activeTabType: 'terminal' as const
    }
    const call = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === 'session.tabs.createTerminal' && frames) {
        const layout = frames.layouts[D]
        frames.send(D, {
          ...layout,
          tabs: [...layout.tabs, serverTerminalTab('terminal', LEAF_1, 'term-1')],
          groups: layout.groups.map((group, index) =>
            index === 0 ? { ...group, tabIds: [...group.tabIds, 'terminal'] } : group
          )
        })
      }
      return {
        id: request.method,
        ok: true,
        result:
          request.method === 'status.get'
            ? {
                ...store.getState().runtimeStatusByEnvironmentId.get('box')!.status,
                runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION
              }
            : request.method === 'session.tabs.createTerminal'
              ? { tab: terminal }
              : snapshot
      }
    })
    Object.assign(window.api.runtimeEnvironments, { call })
    await frames?.start()
    const hook = renderHook(() =>
      useTabGroupCreationCommands({
        worktreeId: D,
        groupId,
        worktreeState: { mobileEmulatorEnabled: false }
      })
    )
    await act(async () => {
      hook.result.current.newTerminalWithShell('pwsh')
    })
    const id = toWebTerminalSurfaceTabId('terminal')
    await waitFor(() =>
      expect(store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === id)?.groupId).toBe(
        groupId
      )
    )
    expect(
      call.mock.calls.find(([request]) => request.method === 'session.tabs.createTerminal')?.[0]
    ).toMatchObject({
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${D}`,
        targetGroupId: undefined,
        ...(supported ? { shell: 'pwsh' } : { command: 'pwsh' })
      }
    })
    expect(
      rawWorkspaceState(store.getState()).unifiedTabsByWorktree[D].find((tab) => tab.id === id)
        ?.groupId
    ).not.toBe(groupId)
    expect(store.getState().activeWorktreeId).toBe(D)
    // Once consumed, later source status does not undo a user's newer outer move.
    store.getState().moveUnifiedTabToGroup(id, 'left', { activate: true, recordInteraction: false })
    admit(store, { ...snapshot, snapshotVersion: 4 })
    expect(store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === id)?.groupId).toBe(
      'left'
    )
  }
)

it.each([
  [false, false],
  [true, true],
  [true, false]
])(
  'duplicates the recovered browser through its real menu, preserving source URL/profile and U (host frames %s, frame before reply %s)',
  async (hostFrames, frameBeforeReply) => {
    const { store, groupId } = setup(hostFrames)
    capability.mockResolvedValue(false)
    const original = {
      ...frame(O, 'chat1', 2),
      tabs: [...frame(O, 'chat1', 2).tabs, browser('original')]
    }
    admit(store, original)
    const source = store
      .getState()
      .unifiedTabsByWorktree[D].find((tab) => tab.contentType === 'browser')!
    store.setState((raw) => ({
      browserTabsByWorktree: {
        ...raw.browserTabsByWorktree,
        [O]: raw.browserTabsByWorktree[O].map((tab) =>
          tab.id === source.entityId ? { ...tab, sessionProfileId: 'profile' } : tab
        )
      }
    }))
    const frames = hostFrames ? await framed(store) : undefined
    const resource = store
      .getState()
      .browserTabsByWorktree[D].find((tab) => tab.id === source.entityId)!
    const snapshot = {
      ...original,
      snapshotVersion: 3,
      tabs: [...original.tabs, browser('duplicate')]
    }
    const call = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (
        frames &&
        request.method === (frameBeforeReply ? 'browser.tabCreate' : 'session.tabs.list')
      ) {
        const layout = frames.layouts[O]
        const originalTab = layout.tabs.find((tab) => tab.kind === 'browser')!
        const originalWorkspace = layout.browserTabs[0]
        frames.send(O, {
          ...layout,
          tabs: [
            ...layout.tabs,
            { ...originalTab, id: 'host-duplicate', entityId: 'workspace-duplicate' }
          ],
          groups: layout.groups.map((group, index) =>
            index === 0 ? { ...group, tabIds: [...group.tabIds, 'host-duplicate'] } : group
          ),
          browserTabs: [
            ...layout.browserTabs,
            { ...originalWorkspace, id: 'workspace-duplicate', pageIds: ['duplicate'] }
          ]
        })
      }
      return {
        id: request.method,
        ok: true,
        result:
          request.method === 'status.get'
            ? {
                ...store.getState().runtimeStatusByEnvironmentId.get('box')!.status,
                runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION
              }
            : request.method === 'browser.tabCreate'
              ? { browserPageId: 'duplicate' }
              : snapshot
      }
    })
    Object.assign(window.api.runtimeEnvironments, { call })
    await frames?.start()
    const hook = renderHook(() =>
      useTabGroupCreationCommands({
        worktreeId: D,
        groupId,
        worktreeState: { mobileEmulatorEnabled: false }
      })
    )
    await act(async () => {
      hook.result.current.duplicateBrowserTab(resource.id, source.id)
    })
    await waitFor(() =>
      expect(
        store.getState().unifiedTabsByWorktree[D].filter((tab) => tab.contentType === 'browser')
      ).toHaveLength(2)
    )
    const duplicate = store
      .getState()
      .unifiedTabsByWorktree[D].find(
        (tab) => tab.contentType === 'browser' && tab.id !== source.id
      )!
    expect(duplicate.groupId).toBe(groupId)
    expect(store.getState().activeGroupIdByWorktree[D]).toBe(groupId)
    expect(
      store.getState().groupsByWorktree[D].find((group) => group.id === groupId)?.activeTabId
    ).toBe(duplicate.id)
    if (hostFrames) {
      const reports = call.mock.calls.filter(([request]) => request.method === 'layout.reportView')
      for (const [request] of reports) {
        expect(Object.values(request.params?.activeGroupByWorkspace ?? {})).not.toContain(groupId)
      }
    }
    expect(
      rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O].some(
        (tab) => tab.id === duplicate.id
      )
    ).toBe(true)
    expect(
      call.mock.calls.find(([request]) => request.method === 'browser.tabCreate')?.[0]
    ).toMatchObject({ params: { worktree: `id:${O}`, url: resource.url, profileId: 'profile' } })
    expect(
      call.mock.calls.find(([request]) => request.method === 'browser.tabCreate')?.[0].params
        ?.targetGroupId
    ).not.toBe(groupId)
    expect(store.getState().activeWorktreeId).toBe(D)
    if (hostFrames) {
      store.setState((raw) => {
        const { [O]: _removed, ...rest } = raw.activeGroupIdByWorktree
        return { activeGroupIdByWorktree: rest }
      })
      store.setState((raw) => ({
        activeGroupIdByWorktree: { ...raw.activeGroupIdByWorktree, [O]: 'source' }
      }))
      await waitFor(() =>
        expect(
          call.mock.calls.some(
            ([request]) =>
              request.method === 'layout.reportView' &&
              Object.values(request.params?.activeGroupByWorkspace ?? {}).includes('source')
          )
        ).toBe(true)
      )
    }
  }
)

it('keeps a failed create from rolling back newer U edits', async () => {
  const { store, groupId } = setup()
  const call = vi.fn(async () => {
    store.getState().focusGroup(D, 'right')
    throw new Error('host refused')
  })
  Object.assign(window.api.runtimeEnvironments, { call })
  const result = await createWebRuntimeSessionTerminalResult({
    worktreeId: O,
    environmentId: 'box',
    targetGroupId: groupId
  })
  expect(result.outcome.status).toBe('failed')
  expect(store.getState().activeWorktreeId).toBe(D)
  expect(store.getState().activeGroupIdByWorktree[D]).toBe('right')
  expect(
    rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O].map((tab) => tab.entityId)
  ).toEqual(['chat1'])
})

it('detaches a recovered source pane through the real command and creator without moving its raw workspace', async () => {
  const { store, groupId } = setup()
  const source = store.getState().createTab(O, 'left', undefined, {
    id: 'source-pane',
    initialLeafId: LEAF_1,
    initialPtyId: 'pty-left'
  })
  store.getState().setTabLayout(source.id, splitLayout())
  const move = vi.fn(async () => ({ status: 'not_held' as const }))
  Object.assign(window.api.pty, { moveLeafToNewTab: move })
  const detached = await detachTerminalPaneToTab({
    getStore: store.getState,
    manager: {
      getPanes: () => [{ id: 1 }, { id: 2 }],
      getLeafId: (id) => (id === 1 ? LEAF_1 : LEAF_2),
      detachPaneForExternalMove: () => true
    },
    persistLayoutSnapshot: () => {},
    sourcePaneId: 2,
    sourceTabId: source.id,
    targetGroupId: groupId,
    targetIndex: 0,
    worktreeId: D
  })
  expect(detached).not.toBeNull()
  expect(move).toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: O, sourceTabId: source.id, leafId: LEAF_2 })
  )
  const id = detached!.tab.id
  expect(rawWorkspaceState(store.getState()).tabsByWorktree[O].some((tab) => tab.id === id)).toBe(
    true
  )
  expect(
    store.getState().groupsByWorktree[D].find((group) => group.id === groupId)?.tabOrder[0]
  ).toBe(id)
  expect(store.getState().terminalLayoutsByTabId[id]?.activeLeafId).toBe(LEAF_2)
})
