/**
 * The runtime bridge's catalog refresh and the parked-tab remount, on real timers and the real
 * store: a parked host-stamped tab remounts once its host's catalog fetch settles, and never after
 * the bridge is stopped while that fetch was in flight.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { subscribeRuntimeEnvironmentFromPreload } from '../../../../preload/runtime-environment-subscriptions'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  clearTerminalTabsParkedOnUnresolvedHost,
  getTabIdsAwaitingHostHydrationRemount,
  recordTerminalTabParkedOnUnresolvedHost
} from '@/lib/parked-terminal-host-hydration'
import { registerRuntimeClientIpcBridge } from './runtime-client-ipc-bridge'

const initialState = useAppStore.getState()
const WT = 'repo1::/w'
const SAVED = 'remote:host-a@@handle-1'

let catalogFetch: PromiseWithResolvers<never[]>

beforeEach(() => {
  clearTerminalTabsParkedOnUnresolvedHost()
  catalogFetch = Promise.withResolvers<never[]>()
  type Ipc = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[0]
  type Args = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[1]
  type Callbacks = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[2]
  const ipc: Ipc = {
    invoke: vi.fn(() => new Promise(() => {})),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  }
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        subscribe: (args: Args, callbacks: Callbacks) =>
          subscribeRuntimeEnvironmentFromPreload(ipc, args, callbacks, () => 'sub-0'),
        call: vi.fn(async () => ({ id: 'r', ok: true, result: [] }))
      }
    }
  })
  const status = createCompatibleRuntimeStatusResponse()
  if (!status.ok) {
    throw new Error('expected valid runtime status fixture')
  }
  useAppStore.setState({
    settings: null,
    runtimeEnvironments: [
      {
        id: 'host-a',
        name: 'Host A',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws', kind: 'websocket', label: 'WS', endpoint: 'ws://x' }],
        preferredEndpointId: 'ws'
      }
    ],
    runtimeStatusByEnvironmentId: new Map([['host-a', { status: status.result, checkedAt: 1 }]]),
    refreshRuntimeEnvironmentStatus: vi.fn(async () => true),
    // The host's catalog read, held open so the test decides when it settles.
    fetchRuntimeEnvironmentRepos: vi.fn(() => catalogFetch.promise),
    repos: [{ id: 'repo1', path: '/w', displayName: 'repo', badgeColor: '#000', addedAt: 1 }],
    tabsByWorktree: {
      [WT]: [
        {
          id: 'tab-1',
          ptyId: SAVED,
          worktreeId: WT,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    ptyIdsByTabId: { 'tab-1': [SAVED] },
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: 'tab-1',
          entityId: 'tab-1',
          groupId: 'group-1',
          worktreeId: WT,
          contentType: 'terminal',
          executionHostId: 'runtime:host-a',
          projectHostSetupId: 'setup-a',
          label: 'Terminal 1',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  })
  // What a refused stamped pane does while its host's setup is unknown.
  recordTerminalTabParkedOnUnresolvedHost(WT, 'tab-1')
})

afterEach(() => {
  catalogFetch.resolve([])
  useAppStore.setState(initialState, true)
  replaceRuntimeEnvironmentRevisions(initialState.runtimeEnvironments)
  clearTerminalTabsParkedOnUnresolvedHost()
  vi.unstubAllGlobals()
})

/** The app-lifetime bridge's remount helper, the callback the runtime bridge is given. */
const remount = vi.fn(() => {
  const store = useAppStore.getState()
  for (const tabId of getTabIdsAwaitingHostHydrationRemount(store)) {
    store.remountTerminalTabForRecovery(tabId)
  }
})

function startBridge(): () => void {
  remount.mockClear()
  const unsubs: (() => void)[] = []
  const unsubscribeStore = registerRuntimeClientIpcBridge(
    unsubs,
    {
      worktreeChangeRefreshQueue: { enqueue: vi.fn(), dispose: vi.fn() },
      activateNotifiedWorktree: vi.fn()
    },
    remount
  )
  return () => {
    unsubscribeStore()
    unsubs.forEach((unsubscribe) => unsubscribe())
  }
}

const generation = (): number =>
  useAppStore.getState().tabsByWorktree[WT]?.find((tab) => tab.id === 'tab-1')?.generation ?? 0

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

it('remounts the parked tab exactly once when the catalog fetch settles before disposal', async () => {
  const stop = startBridge()
  await vi.waitFor(() =>
    expect(useAppStore.getState().fetchRuntimeEnvironmentRepos).toHaveBeenCalledWith('host-a')
  )
  catalogFetch.resolve([])
  await vi.waitFor(() => expect(remount).toHaveBeenCalledOnce())
  await settle()
  expect(remount).toHaveBeenCalledOnce()
  expect(generation()).toBe(1)
  stop()
})

it('neither remounts nor bumps the generation when stopped while the fetch was in flight', async () => {
  const stop = startBridge()
  await vi.waitFor(() =>
    expect(useAppStore.getState().fetchRuntimeEnvironmentRepos).toHaveBeenCalledWith('host-a')
  )
  stop()
  catalogFetch.resolve([])
  await settle()

  expect(remount).not.toHaveBeenCalled()
  expect(generation()).toBe(0)
})
