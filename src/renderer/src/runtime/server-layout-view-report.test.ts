import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as FrameDrawnModule from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { _resetLayoutFramePositionForTests } from './layout-frame-position'
import {
  CAPABLE,
  ENV,
  HOST_GROUP,
  WT,
  SERVER_LAYOUT,
  createFakeLayoutStreams,
  createServerHarness,
  settle,
  type TestStore
} from './server-layout-frames.test-fixture'
import {
  isFrameDrawnServerWorkspace,
  resetFrameDrawnServerWorkspacesForTests
} from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { resetMirroredTerminalHandlesForTests } from './web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

type Subscribe = (...args: never[]) => { close: () => void }
const hoisted = vi.hoisted(
  (): {
    owners: Map<string, string>
    resync: Mock<(environmentId: string, worktreeId: string) => Promise<void>>
    call: Mock<(target: unknown, method: string, params?: unknown) => Promise<unknown>>
    subscribe: Subscribe | null
  } => ({
    owners: new Map(),
    resync: vi.fn(),
    call: vi.fn(),
    subscribe: null
  })
)

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (...args: never[]) => hoisted.subscribe!(...args)
}))
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (target: unknown, method: string, params?: unknown) =>
    hoisted.call(target, method, params)
}))
vi.mock('./web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (_state: unknown, key: string) =>
    hoisted.owners.get(key) ?? null
}))
vi.mock('./web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))

createStoreSessionMockApi()

const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe

/** A workspace this window holds that no server's frames draw. */
const LOCAL_WT = 'repo::/local-worktree'
const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

beforeEach(() => {
  hoisted.owners.clear()
  hoisted.resync.mockReset().mockResolvedValue(undefined)
  hoisted.call.mockReset().mockResolvedValue({ ok: true })
  streams.all.length = 0
  resetWebSessionTabsSyncTestState()
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
})
afterEach(uninstallAll)

type ControlEvent = {
  environmentId: string
  transportGeneration: number
  diagnostics: { state: string; lastConnectedAt: number | null }
}
const controlListeners = new Set<(event: ControlEvent) => void>()
beforeEach(() => {
  controlListeners.clear()
  Object.assign(window.api.runtimeEnvironments ?? {}, {
    onSharedControlDiagnostics: (listener: (event: ControlEvent) => void) => {
      controlListeners.add(listener)
      return () => controlListeners.delete(listener)
    }
  })
})

/** The shared control connection's state, as main broadcasts it. */
function control(
  environmentId: string,
  state: string,
  transportGeneration: number,
  lastConnectedAt: number
): void {
  for (const listener of controlListeners) {
    listener({ environmentId, transportGeneration, diagnostics: { state, lastConnectedAt } })
  }
}

function reports(): unknown[] {
  return hoisted.call.mock.calls
    .filter(([, method]) => method === 'layout.reportView')
    .map(([target, , params]) => ({ target, params }))
}

function showGroup(store: TestStore, key: string, groupId: string): void {
  store.setState({
    activeGroupIdByWorktree: { ...store.getState().activeGroupIdByWorktree, [key]: groupId }
  })
}

async function frameDrawnStore(): Promise<TestStore> {
  const store = mirroredStore()
  showGroup(store, LOCAL_WT, 'local-group')
  install(store)
  setServers(store, [CAPABLE])
  streams.send(streams.openTo(ENV), {
    type: 'snapshot',
    workspaces: [{ key: WT, layout: SERVER_LAYOUT }],
    seq: 1,
    epoch: 'e'
  })
  await settle()
  return store
}

/** ENV's workspace with a second, empty group beside the first. */
const TWO_GROUPS = {
  ...SERVER_LAYOUT,
  groups: [
    { id: HOST_GROUP, tabIds: ['host-tab-1'] },
    { id: 'host-group-2', tabIds: [] }
  ],
  groupLayout: {
    type: 'split' as const,
    direction: 'horizontal' as const,
    first: { type: 'leaf' as const, groupId: HOST_GROUP },
    second: { type: 'leaf' as const, groupId: 'host-group-2' }
  }
}

describe('the group this window shows, told to the server whose frames draw it', () => {
  it('reports the frame-drawn workspaces only', async () => {
    await frameDrawnStore()

    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    expect(reports()).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { activeGroupByWorkspace: { [WT]: HOST_GROUP }, refresh: true }
      }
    ])
  })

  it('sends again only when a group changes', async () => {
    const store = await frameDrawnStore()
    hoisted.call.mockClear()

    showGroup(store, LOCAL_WT, 'local-group-2')
    store.setState({ activeGroupIdByWorktree: { ...store.getState().activeGroupIdByWorktree } })
    expect(reports()).toEqual([])

    showGroup(store, WT, 'host-group-2')
    showGroup(store, WT, 'host-group-2')
    expect(reports()).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { activeGroupByWorkspace: { [WT]: 'host-group-2' } }
      }
    ])
  })

  it('does not resend a report the server failed to take', async () => {
    hoisted.call.mockRejectedValue(new Error('offline'))
    const store = await frameDrawnStore()
    store.setState({ activeGroupIdByWorktree: { ...store.getState().activeGroupIdByWorktree } })
    await settle()

    expect(reports()).toHaveLength(1)
  })

  it("reports again on a new stream's snapshot as a refresh, then a change as live", async () => {
    const store = await frameDrawnStore()
    hoisted.call.mockClear()

    streams.send(streams.openTo(ENV), {
      type: 'snapshot',
      workspaces: [{ key: WT, layout: SERVER_LAYOUT }],
      seq: 2,
      epoch: 'e2'
    })
    await settle()

    expect(reports()).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { activeGroupByWorkspace: { [WT]: HOST_GROUP }, refresh: true }
      }
    ])

    hoisted.call.mockClear()
    showGroup(store, WT, 'host-group-2')
    expect(reports()).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { activeGroupByWorkspace: { [WT]: 'host-group-2' } }
      }
    ])
  })

  it('sends nothing to a server without layout intents', async () => {
    const store = mirroredStore()
    install(store)
    setServers(store, [{ ...CAPABLE, capable: false }])
    showGroup(store, WT, 'host-group-2')
    await settle()

    // Presence: the server is paired and its workspace mirrored, with a group shown.
    expect(store.getState().runtimeEnvironments.map((environment) => environment.id)).toEqual([ENV])
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe('host-group-2')
    expect(reports()).toEqual([])
  })

  it('reports again as a refresh when the control connection comes up on a new socket, the stream still up', async () => {
    const store = await frameDrawnStore()
    control(ENV, 'ready', 1, 100)
    showGroup(store, WT, 'host-group-2')
    hoisted.call.mockClear()

    control(ENV, 'reconnecting', 1, 100)
    control(ENV, 'ready', 1, 100)
    control('web-env-other', 'ready', 1, 200)
    expect(reports()).toEqual([])

    control(ENV, 'ready', 1, 200)
    control(ENV, 'ready', 2, 200)
    expect(streams.openTo(ENV).closed).toBe(false)
    const again = {
      target: { kind: 'environment', environmentId: ENV },
      params: { activeGroupByWorkspace: { [WT]: 'host-group-2' }, refresh: true }
    }
    expect(reports()).toEqual([again, again])
  })

  it('stops sending, and warns once, after a server answers it has no such method', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoisted.call.mockRejectedValue(new Error('method_not_found'))
    const store = await frameDrawnStore()
    expect(reports()).toHaveLength(1)

    showGroup(store, WT, 'host-group-2')
    streams.send(streams.openTo(ENV), {
      type: 'snapshot',
      workspaces: [{ key: WT, layout: SERVER_LAYOUT }],
      seq: 2,
      epoch: 'e2'
    })
    control(ENV, 'ready', 3, 300)
    await settle()

    expect(reports()).toHaveLength(1)
    expect(warn.mock.calls.filter(([line]) => String(line).includes('view report'))).toHaveLength(1)
    warn.mockRestore()
  })

  it("sends a snapshot's own group move as a refresh, never as a live report", async () => {
    const store = mirroredStore()
    install(store)
    setServers(store, [CAPABLE])
    streams.send(streams.openTo(ENV), {
      type: 'snapshot',
      workspaces: [{ key: WT, layout: TWO_GROUPS }],
      seq: 1,
      epoch: 'e'
    })
    await settle()
    showGroup(store, WT, 'host-group-2')
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe('host-group-2')
    hoisted.call.mockClear()

    // The server closed the group the desktop showed: its snapshot moves the desktop's view.
    streams.send(streams.openTo(ENV), {
      type: 'snapshot',
      workspaces: [{ key: WT, layout: SERVER_LAYOUT }],
      seq: 2,
      epoch: 'e2'
    })
    await settle()

    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(HOST_GROUP)
    expect(reports()).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { activeGroupByWorkspace: { [WT]: HOST_GROUP }, refresh: true }
      }
    ])
  })

  it("sends a later frame's group move as a refresh, after a live report", async () => {
    const store = mirroredStore()
    install(store)
    setServers(store, [CAPABLE])
    const stream = streams.openTo(ENV)
    streams.send(stream, {
      type: 'snapshot',
      workspaces: [{ key: WT, layout: TWO_GROUPS }],
      seq: 1
    })
    await settle()
    showGroup(store, WT, 'host-group-2')
    expect(reports().at(-1)).toEqual({
      target: { kind: 'environment', environmentId: ENV },
      params: { activeGroupByWorkspace: { [WT]: 'host-group-2' } }
    })
    hoisted.call.mockClear()

    // The server closes the group the desktop shows, in a frame after the snapshot.
    streams.send(stream, { type: 'workspace', key: WT, layout: SERVER_LAYOUT, seq: 2 })
    await settle()

    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(HOST_GROUP)
    expect(reports()).toEqual([
      {
        target: { kind: 'environment', environmentId: ENV },
        params: { activeGroupByWorkspace: { [WT]: HOST_GROUP }, refresh: true }
      }
    ])
  })
})
