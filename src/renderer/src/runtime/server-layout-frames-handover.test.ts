import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as FrameDrawnModule from './web-session-tabs-sync/frame-drawn-server-workspaces'
import type { AppState } from '@/store/types'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { _resetLayoutFramePositionForTests } from './layout-frame-position'
import { mainLayoutFrameSender } from './main-loaded-layout-frames.test-fixture'
import { serverLayoutForDesktop } from './server-layout-frame-ids'
import {
  CAPABLE,
  ENV,
  LEAF_ID,
  WT,
  SECOND_LEAF_ID,
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
  treeOf,
  type TestStore
} from './server-layout-frames.test-fixture'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'
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
const TAB_2 = toWebTerminalSurfaceTabId('host-tab-2')
const REMOTE_1 = toRemoteRuntimePtyId('terminal-1', ENV)
const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

/** The server's layout once it opened a second terminal tab, bound on the server. */
const WITH_TAB_2 = serverLayout([
  serverTerminalTab('host-tab-1', LEAF_ID, 'server-pty-1'),
  serverTerminalTab('host-tab-2', SECOND_LEAF_ID, 'server-pty-2', 2)
])

/** The workspace as the store shows it, in the published shape the frames translate to. */
function publishedStoreTree(state: AppState): PublishedWorkspaceLayout {
  const host = toRuntimeExecutionHostId(ENV)
  const { layout } = loadWorkspaceLayoutWithoutReport(
    host,
    buildWorkspaceSessionPayload(state),
    nameBasedLoadContext()
  )
  return publishWorkspaceLayout(layout.workspaces[WT]!, host)
}

/** Every state the store passes through, from now until `stop`. */
function recordStates(store: TestStore) {
  const states: AppState[] = [store.getState()]
  const stop = store.subscribe((state) => states.push(state))
  return { states, stop }
}

/** A mirrored store whose WT the server's stream now draws, shown from its snapshot. */
async function frameDrawnStore(store = mirroredStore()) {
  install(store)
  setServers(store, [CAPABLE])
  const stream = streams.openTo(ENV)
  const frames = mainLayoutFrameSender()
  streams.send(stream, senderSnapshot(frames, { [WT]: SERVER_LAYOUT }, 1))
  await settle()
  return { store, stream, frames }
}

const bindingOf = (state: AppState, tabId: string, leafId: string) =>
  state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]

/** How many times a pane's binding changed across the recorded states. */
function bindingChanges(states: AppState[], tabId: string, leafId: string): number {
  return states.filter(
    (state, index) =>
      index > 0 && bindingOf(state, tabId, leafId) !== bindingOf(states[index - 1]!, tabId, leafId)
  ).length
}

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  hoisted.owners.clear()
  hoisted.resync.mockReset().mockResolvedValue(undefined)
  streams.all.length = 0
  resetWebSessionTabsSyncTestState()
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  uninstallAll()
  check.uninstall()
  expect(check.failures).toEqual([])
})

describe('mirror to frames', () => {
  it('gates the workspace before the snapshot shows, then shows it with no empty state and no reattach', async () => {
    const store = mirroredStore()
    const mirrorTree = treeOf(store.getState(), WT)
    expect(mirrorTree.bindings).toEqual({ [TAB_1]: { [LEAF_ID]: REMOTE_1 } })
    // The server's snapshot translates to exactly the tree the mirror drew.
    const handleOf = (hostTabId: string, leafId: string) =>
      hostTabId === 'host-tab-1' && leafId === LEAF_ID ? 'terminal-1' : null
    expect(serverLayoutForDesktop(SERVER_LAYOUT, ENV, handleOf)).toEqual(
      publishedStoreTree(store.getState())
    )
    install(store)
    setServers(store, [CAPABLE])
    const stream = streams.openTo(ENV)
    const recorded = recordStates(store)

    streams.send(stream, {
      type: 'snapshot',
      workspaces: [{ key: WT, layout: SERVER_LAYOUT }],
      seq: 1,
      epoch: 'e'
    })

    // Before the frame's flush: the gate is up and the store still shows the mirror's tree.
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    expect(check.fullBuilt).toEqual([])
    expect(treeOf(store.getState(), WT)).toEqual(mirrorTree)
    await settle()
    recorded.stop()

    // Presence: the frames built the workspace; the same tree needed no store write at all.
    expect(check.fullBuilt).toEqual([WT])
    expect(recorded.states).toHaveLength(1)
    expect(treeOf(store.getState(), WT)).toEqual(mirrorTree)
  })

  it('writes what the frames change over the mirror’s tree without emptying it between', async () => {
    const store = mirroredStore()
    const mirrorTree = treeOf(store.getState(), WT)
    expect(mirrorTree.tabIds).toEqual([TAB_1])
    install(store)
    setServers(store, [CAPABLE])
    const recorded = recordStates(store)
    const renamed = structuredClone(SERVER_LAYOUT)
    renamed.tabs[0]!.customTitle = 'named on the server'

    streams.send(streams.openTo(ENV), {
      type: 'snapshot',
      workspaces: [{ key: WT, layout: renamed }],
      seq: 1,
      epoch: 'e'
    })
    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(true)
    await settle()
    recorded.stop()

    expect(store.getState().tabsByWorktree[WT]?.[0]?.customTitle).toBe('named on the server')
    expect(recorded.states.length).toBeGreaterThan(1)
    for (const state of recorded.states) {
      expect(treeOf(state, WT)).toEqual(mirrorTree)
    }
  })
})

describe('a terminal handle and the frame that binds its pane, in either order', () => {
  it('shows the pane pending until session.tabs has its handle, then binds it once in place', async () => {
    const { store, stream, frames } = await frameDrawnStore()
    streams.send(stream, frames.records(WT, WITH_TAB_2))
    await settle()
    const tabsBefore = (store.getState().tabsByWorktree[WT] ?? []).map((tab) => tab.id)
    expect(tabsBefore).toEqual([TAB_1, TAB_2])
    const pending = store.getState().terminalLayoutsByTabId[TAB_2]
    expect(pending?.root).toEqual({ type: 'leaf', leafId: SECOND_LEAF_ID })
    expect(pending?.ptyIdsByLeafId ?? {}).not.toHaveProperty(SECOND_LEAF_ID)
    const recorded = recordStates(store)

    mirrorSnapshot(
      store,
      ENV,
      sessionTabs(
        [
          surface('host-tab-1', LEAF_ID, 'terminal-1'),
          surface('host-tab-2', SECOND_LEAF_ID, 'terminal-2')
        ],
        2
      )
    )
    await settle()
    recorded.stop()

    const bound = toRemoteRuntimePtyId('terminal-2', ENV)
    expect(bindingOf(store.getState(), TAB_2, SECOND_LEAF_ID)).toBe(bound)
    expect(bindingChanges(recorded.states, TAB_2, SECOND_LEAF_ID)).toBe(1)
    for (const state of recorded.states) {
      expect((state.tabsByWorktree[WT] ?? []).map((tab) => tab.id)).toEqual(tabsBefore)
      expect(state.terminalLayoutsByTabId[TAB_2]?.root).toEqual(pending?.root)
    }
    // The other pane kept its binding throughout.
    expect(bindingChanges(recorded.states, TAB_1, LEAF_ID)).toBe(0)
    expect(bindingOf(store.getState(), TAB_1, LEAF_ID)).toBe(REMOTE_1)
  })

  it('binds the pane in the frame’s own flush when session.tabs had its handle first', async () => {
    const { store, stream, frames } = await frameDrawnStore()
    mirrorSnapshot(
      store,
      ENV,
      sessionTabs(
        [
          surface('host-tab-1', LEAF_ID, 'terminal-1'),
          surface('host-tab-2', SECOND_LEAF_ID, 'terminal-2')
        ],
        2
      )
    )
    await settle()
    // The gated mirror drew no tab of its own for the handle.
    expect(store.getState().terminalLayoutsByTabId[TAB_2]).toBeUndefined()
    const recorded = recordStates(store)

    streams.send(stream, frames.records(WT, WITH_TAB_2))
    await settle()
    recorded.stop()

    const bound = toRemoteRuntimePtyId('terminal-2', ENV)
    expect(bindingOf(store.getState(), TAB_2, SECOND_LEAF_ID)).toBe(bound)
    // The first state holding the tab already holds its binding.
    const firstShown = recorded.states.find((state) => state.terminalLayoutsByTabId[TAB_2])
    expect(bindingOf(firstShown!, TAB_2, SECOND_LEAF_ID)).toBe(bound)
    expect(bindingChanges(recorded.states, TAB_2, SECOND_LEAF_ID)).toBe(1)
  })

  it('rebinds a pane that stays bound exactly once when its handle is replaced', async () => {
    const { store } = await frameDrawnStore()
    expect(bindingOf(store.getState(), TAB_1, LEAF_ID)).toBe(REMOTE_1)
    const recorded = recordStates(store)

    mirrorSnapshot(store, ENV, sessionTabs([surface('host-tab-1', LEAF_ID, 'terminal-1b')], 2))
    await settle()
    recorded.stop()

    expect(bindingOf(store.getState(), TAB_1, LEAF_ID)).toBe(
      toRemoteRuntimePtyId('terminal-1b', ENV)
    )
    expect(bindingChanges(recorded.states, TAB_1, LEAF_ID)).toBe(1)
    for (const state of recorded.states) {
      expect((state.tabsByWorktree[WT] ?? []).map((tab) => tab.id)).toEqual([TAB_1])
    }
  })
})

describe('a workspace handed back to the mirror', () => {
  it('is not drawn from the stopped stream’s frames while the stream reconnects', async () => {
    const other = 'repo::/other-worktree'
    hoisted.owners.set(other, ENV)
    const store = mirroredStore()
    install(store)
    setServers(store, [CAPABLE])
    const stream = streams.openTo(ENV)
    const frames = mainLayoutFrameSender()
    const otherLayout = {
      ...serverLayout([serverTerminalTab('host-tab-9', LEAF_ID, 'server-pty-9')]),
      worktreeId: other
    }
    streams.send(stream, senderSnapshot(frames, { [WT]: SERVER_LAYOUT, [other]: otherLayout }, 1))
    await settle()
    stream.onStatus({ state: 'lost' })
    stream.onStatus({ state: 'connecting' })
    await settle()

    // The mirror's first snapshot of the other workspace, after it took it back.
    mirrorSnapshot(store, ENV, {
      ...sessionTabs([surface('host-tab-8', LEAF_ID, 'terminal-8')], 1),
      worktree: other
    })
    await settle()

    expect((store.getState().tabsByWorktree[other] ?? []).map((tab) => tab.id)).toEqual([
      toWebTerminalSurfaceTabId('host-tab-8')
    ])
  })
})

describe('two desktop windows', () => {
  it('bind identical ptyIds from the same server frames and handles', async () => {
    const first = mirroredStore()
    const second = mirroredStore()
    install(first)
    install(second)
    setServers(first, [CAPABLE])
    setServers(second, [CAPABLE])
    const open = streams.of(ENV).filter((stream) => !stream.closed)
    expect(open).toHaveLength(2)
    for (const stream of open) {
      const frames = mainLayoutFrameSender()
      streams.send(stream, senderSnapshot(frames, { [WT]: SERVER_LAYOUT }, 1))
      streams.send(stream, frames.records(WT, WITH_TAB_2))
    }
    await settle()
    const handles = sessionTabs(
      [
        surface('host-tab-1', LEAF_ID, 'terminal-1'),
        surface('host-tab-2', SECOND_LEAF_ID, 'terminal-2')
      ],
      2
    )
    mirrorSnapshot(first, ENV, handles)
    mirrorSnapshot(second, ENV, handles)
    await settle()

    const expected = {
      [TAB_1]: { [LEAF_ID]: REMOTE_1 },
      [TAB_2]: { [SECOND_LEAF_ID]: toRemoteRuntimePtyId('terminal-2', ENV) }
    }
    expect(treeOf(first.getState(), WT).bindings).toEqual(expected)
    expect(treeOf(second.getState(), WT)).toEqual(treeOf(first.getState(), WT))
  })
})
