import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import type * as FrameDrawnModule from '../../web-session-tabs-sync/frame-drawn-server-workspaces'
import type { AppState } from '@/store/types'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'
import { _resetLayoutFramePositionForTests } from '../frames/layout-frame-position'
import { mainLayoutFrameSender } from '../testing/main-loaded-layout-frames.test-fixture'
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
  type TestStore
} from './testing/server-layout-frames.test-fixture'
import { installLayoutFrameApplyCheck } from '../testing/workspace-layout-frame-apply-check.test-fixture'
import { resetFrameDrawnServerWorkspacesForTests } from '../../web-session-tabs-sync/frame-drawn-server-workspace-set'
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
const TAB_2 = toWebTerminalSurfaceTabId('host-tab-2')
const REMOTE_1 = toRemoteRuntimePtyId('terminal-1', ENV)
const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

/** The server's layout once it opened a second terminal tab, bound on the server. */
const WITH_TAB_2 = serverLayout([
  serverTerminalTab('host-tab-1', LEAF_ID, 'server-pty-1'),
  serverTerminalTab('host-tab-2', SECOND_LEAF_ID, 'server-pty-2', 2)
])

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
})
