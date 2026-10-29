import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as FrameDrawnModule from './web-session-tabs-sync/frame-drawn-server-workspaces'
import type { AppState } from '@/store/types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import {
  _resetLayoutFramePositionForTests,
  afterLayoutFrame,
  beginLayoutFramePositions,
  noteLayoutFramePosition
} from './layout-frame-position'
import { mainLayoutFrameSender } from './main-loaded-layout-frames.test-fixture'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'
import {
  CAPABLE,
  ENV,
  LEAF_ID,
  WT,
  SERVER_LAYOUT,
  createFakeLayoutStreams,
  createServerHarness,
  mirrorSnapshot,
  serverLayout,
  serverTerminalTab,
  senderSnapshot,
  sessionTabs,
  settle,
  surface,
  treeOf
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
    subscribe: Subscribe | null
  } => ({
    owners: new Map(),
    resync: vi.fn(),
    subscribe: null
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
// Why not mock its RPC instead: vitest gives concurrent dynamic imports of a mocked module the real one.
vi.mock('./web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))

createStoreSessionMockApi()

const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe

const TAB_1 = toWebTerminalSurfaceTabId('host-tab-1')
const OTHER_ENV = 'web-env-2'
const OTHER_WT = 'repo::/other-worktree'
const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

beforeEach(() => {
  hoisted.owners.clear()
  hoisted.resync.mockReset().mockResolvedValue(undefined)
  streams.all.length = 0
  resetWebSessionTabsSyncTestState()
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
})
afterEach(uninstallAll)

describe('which servers get a layout stream', () => {
  it('opens one only for a reachable server whose verified status advertises layout intents', () => {
    const store = mirroredStore()
    install(store)
    expect(streams.all).toEqual([])

    setServers(store, [
      CAPABLE,
      { environmentId: OTHER_ENV, runtimeId: 'runtime-2', capable: false }
    ])

    expect(streams.all.map((stream) => stream.target)).toEqual([
      { kind: 'environment', environmentId: ENV }
    ])
  })

  it('leaves every workspace of an older server to the mirror', async () => {
    const store = mirroredStore()
    install(store)
    setServers(store, [{ ...CAPABLE, capable: false }])
    await settle()

    // Presence: the server is paired and connected, and its workspace mirrored.
    expect(store.getState().runtimeEnvironments.map((environment) => environment.id)).toEqual([ENV])
    expect(store.getState().runtimeStatusByEnvironmentId.get(ENV)?.status?.runtimeId).toBe(
      'runtime-1'
    )
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([TAB_1])
    expect(streams.all).toEqual([])
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
    // The mirror still writes the layout: a renamed tab shows.
    mirrorSnapshot(
      store,
      ENV,
      sessionTabs([{ ...surface('host-tab-1', LEAF_ID, 'terminal-1'), title: 'renamed' }], 2)
    )
    expect(store.getState().tabsByWorktree[WT]?.[0]?.title).toBe('renamed')
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
  })

  it.each([
    ['is unpaired', []],
    ['disconnects', [{ ...CAPABLE, disconnected: true }]]
  ] as const)(
    'closes the stream of a server that %s and hands its workspaces back (L19)',
    async (_, after) => {
      const store = mirroredStore()
      install(store)
      setServers(store, [CAPABLE])
      const stream = streams.openTo(ENV)
      streams.send(stream, {
        type: 'snapshot',
        workspaces: [{ key: WT, layout: SERVER_LAYOUT }],
        seq: 1,
        epoch: 'e'
      })
      await settle()
      expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
      expect(hoisted.resync).not.toHaveBeenCalled()

      setServers(store, [...after])

      expect(stream.closed).toBe(true)
      expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
      await settle()
      expect(hoisted.resync.mock.calls).toEqual([[ENV, WT]])
    }
  )

  it.each([
    ['a new runtime id', { runtimeId: 'runtime-1b' }],
    ['a new pairing revision', { pairingRevision: 2 }]
  ] as const)('replaces the stream on %s without handing back first', async (_, change) => {
    const store = mirroredStore()
    install(store)
    setServers(store, [CAPABLE])
    const first = streams.openTo(ENV)
    streams.send(first, {
      type: 'snapshot',
      workspaces: [{ key: WT, layout: SERVER_LAYOUT }],
      seq: 1,
      epoch: 'e'
    })
    await settle()
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)

    setServers(store, [{ ...CAPABLE, ...change }])
    await settle()

    expect(first.closed).toBe(true)
    const second = streams.openTo(ENV)
    expect(second).not.toBe(first)
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    expect(hoisted.resync).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([TAB_1])
  })

  it.each(['lost', 'refused'] as const)(
    'hands the workspaces back when the replacement is %s before its snapshot',
    async (state) => {
      const store = mirroredStore()
      install(store)
      setServers(store, [CAPABLE])
      streams.send(streams.openTo(ENV), {
        type: 'snapshot',
        workspaces: [{ key: WT, layout: SERVER_LAYOUT }],
        seq: 1,
        epoch: 'e'
      })
      await settle()
      setServers(store, [{ ...CAPABLE, runtimeId: 'runtime-1b' }])
      expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)

      streams
        .openTo(ENV)
        .onStatus(state === 'lost' ? { state } : { state, code: 'method_not_found' })
      await settle()

      expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
      expect(hoisted.resync.mock.calls).toEqual([[ENV, WT]])
    }
  )
})

describe('frames to mirror', () => {
  it.each(['lost', 'refused'] as const)(
    'clears the gate and resyncs each workspace when the stream is %s, keeping the frame tree until then',
    async (state) => {
      const store = mirroredStore()
      hoisted.owners.set(OTHER_WT, ENV)
      mirrorSnapshot(store, ENV, {
        ...sessionTabs([surface('host-tab-9', LEAF_ID, 'terminal-9')], 1),
        worktree: OTHER_WT
      })
      install(store)
      setServers(store, [CAPABLE])
      const stream = streams.openTo(ENV)
      streams.send(stream, {
        type: 'snapshot',
        workspaces: [
          { key: WT, layout: SERVER_LAYOUT },
          {
            key: OTHER_WT,
            layout: {
              ...serverLayout([serverTerminalTab('host-tab-9', LEAF_ID, 'server-pty-9')]),
              worktreeId: OTHER_WT
            }
          }
        ],
        seq: 1,
        epoch: 'e'
      })
      await settle()
      expect([
        isFrameDrawnServerWorkspace(ENV, WT),
        isFrameDrawnServerWorkspace(ENV, OTHER_WT)
      ]).toEqual([true, true])
      const frameTree = treeOf(store.getState(), WT)
      expect(frameTree.tabIds).toEqual([TAB_1])
      // The resync never answers here: whatever the store shows meanwhile is the frames'.
      hoisted.resync.mockReturnValue(new Promise(() => {}))
      const states: AppState[] = []
      const stop = store.subscribe((next) => states.push(next))

      stream.onStatus(state === 'lost' ? { state } : { state, code: 'forbidden' })
      await settle()
      stop()

      expect([
        isFrameDrawnServerWorkspace(ENV, WT),
        isFrameDrawnServerWorkspace(ENV, OTHER_WT)
      ]).toEqual([false, false])
      expect(hoisted.resync.mock.calls).toEqual([
        [ENV, WT],
        [ENV, OTHER_WT]
      ])
      expect(treeOf(store.getState(), WT)).toEqual(frameTree)
      for (const recorded of states) {
        expect(treeOf(recorded, WT)).toEqual(frameTree)
      }
    }
  )
})

describe('a workspace that turns out to be the server’s after its snapshot', () => {
  it('stays the mirror’s until routing names its owner, then draws from frames until the stream stops', async () => {
    const store = mirroredStore()
    hoisted.owners.delete(WT)
    install(store)
    setServers(store, [CAPABLE])
    const check = installLayoutFrameApplyCheck()
    try {
      const stream = streams.openTo(ENV)
      const frames = mainLayoutFrameSender()
      const before = store.getState()
      const recorded: AppState[] = []
      const stop = store.subscribe((state) => recorded.push(state))

      streams.send(stream, senderSnapshot(frames, { [WT]: SERVER_LAYOUT }, 1))
      await settle()
      stop()

      // Presence: the snapshot carried the workspace, and the mirror drew it.
      expect(treeOf(before, WT).tabIds).toEqual([TAB_1])
      expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
      expect(recorded).toEqual([])
      expect(check.fullBuilt).toEqual([])

      hoisted.owners.set(WT, ENV)
      // A routing slice moves, as pairing does when it names the workspace's owner.
      store.setState({ repos: [...store.getState().repos] })
      expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
      await settle()
      expect(check.fullBuilt).toEqual([WT])

      const renamed = structuredClone(SERVER_LAYOUT)
      renamed.tabs[0]!.customTitle = 'renamed on the server'
      streams.send(stream, frames.records(WT, renamed))
      await settle()
      expect(store.getState().tabsByWorktree[WT]?.[0]?.customTitle).toBe('renamed on the server')

      stream.onStatus({ state: 'lost' })
      await settle()
      expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
      expect(hoisted.resync.mock.calls).toEqual([[ENV, WT]])
      // The owner still reads ENV: a routing change after the loss must not take it back.
      expect(hoisted.owners.get(WT)).toBe(ENV)
      store.setState({ repos: [...store.getState().repos] })
      await settle()
      expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
      expect(check.failures).toEqual([])
    } finally {
      check.uninstall()
    }
  })
})

describe('a workspace whose owner briefly reads unknown', () => {
  it('is drawn from frames in full again when it rejoins the gate', async () => {
    const store = mirroredStore()
    install(store)
    setServers(store, [CAPABLE])
    const check = installLayoutFrameApplyCheck()
    try {
      const stream = streams.openTo(ENV)
      streams.send(stream, senderSnapshot(mainLayoutFrameSender(), { [WT]: SERVER_LAYOUT }, 1))
      await settle()
      expect(check.fullBuilt).toEqual([WT])

      hoisted.owners.delete(WT)
      store.setState({ repos: [...store.getState().repos] })
      expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
      hoisted.owners.set(WT, ENV)
      store.setState({ repos: [...store.getState().repos] })
      expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
      await settle()

      // The mirror may have drawn it in the gap: the frames redraw it rather than trust it.
      expect(check.fullBuilt).toEqual([WT, WT])
      expect(check.failures).toEqual([])
    } finally {
      check.uninstall()
    }
  })
})

describe('server frames and this window’s layout.apply positions', () => {
  it('never release a local wait, whatever their seq, nor end it when the server stream stops', async () => {
    const store = mirroredStore()
    install(store)
    setServers(store, [CAPABLE])
    beginLayoutFramePositions()
    const waiter = vi.fn()
    afterLayoutFrame(3, waiter)
    const stream = streams.openTo(ENV)
    // Presence: the stream reports positions, as the real client does.
    expect(stream.onPosition).toBeTypeOf('function')
    const frames = mainLayoutFrameSender()

    streams.send(stream, senderSnapshot(frames, { [WT]: SERVER_LAYOUT }, 5))
    const renamed = structuredClone(SERVER_LAYOUT)
    renamed.tabs[0]!.customTitle = 'renamed'
    streams.send(stream, frames.records(WT, renamed, 9))
    await settle()
    // Presence: the frames did show.
    expect(store.getState().tabsByWorktree[WT]?.[0]?.customTitle).toBe('renamed')
    stream.onStatus({ state: 'lost' })
    await settle()
    expect(waiter).not.toHaveBeenCalled()

    noteLayoutFramePosition(3)
    expect(waiter).toHaveBeenCalledTimes(1)
  })
})
