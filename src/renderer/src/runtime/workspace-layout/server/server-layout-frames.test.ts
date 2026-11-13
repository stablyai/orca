import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import type * as FrameDrawnModule from '../../web-session-tabs-sync/frame-drawn-server-workspaces'
import type { AppState } from '@/store/types'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'
import {
  _resetLayoutFramePositionForTests,
  afterLayoutFrame,
  beginLayoutFramePositions,
  noteLayoutFramePosition
} from '../frames/layout-frame-position'
import { mainLayoutFrameSender } from '../testing/main-loaded-layout-frames.test-fixture'
import { installLayoutFrameApplyCheck } from '../testing/workspace-layout-frame-apply-check.test-fixture'
import {
  CAPABLE,
  ENV,
  WT,
  SERVER_LAYOUT,
  createFakeLayoutStreams,
  createServerHarness,
  senderSnapshot,
  settle,
  treeOf
} from './testing/server-layout-frames.test-fixture'
import {
  isFrameDrawnServerWorkspace,
  resetFrameDrawnServerWorkspacesForTests
} from '../../web-session-tabs-sync/frame-drawn-server-workspace-set'
import { resetMirroredTerminalHandlesForTests } from '../../web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'

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

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('../frames/runtime-layout-client', () => ({
  subscribeRuntimeLayout: (...args: never[]) => hoisted.subscribe!(...args)
}))
vi.mock('../../web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (_state: unknown, key: string) =>
    hoisted.owners.get(key) ?? null
}))
// Why not mock its RPC instead: vitest gives concurrent dynamic imports of a mocked module the real one.
vi.mock('../../web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))

createStoreSessionMockApi()

const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe

const TAB_1 = toWebTerminalSurfaceTabId('host-tab-1')
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
