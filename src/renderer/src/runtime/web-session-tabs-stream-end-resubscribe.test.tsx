// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { AppState } from '@/store/types'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'

const mocks = vi.hoisted(() => ({
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKeys: () => ({
    environmentKey: `env-a\u0001runtime-a\u00011\u0001101`,
    resubscribeSignal: ''
  })
}))
vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRuntimeOwnerModule>()
  return {
    ...actual,
    getExplicitRuntimeEnvironmentIdForWorktree: mocks.getExplicitRuntimeEnvironmentIdForWorktree
  }
})
vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: async (_state: unknown, snapshot: unknown) =>
    snapshot
}))

import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'
import { WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS } from './window-visibility-subscription-parking'

/**
 * #21052/#19092: the host can end a tab stream while the connection stays up (an id-less
 * unsubscribeAll sweep, an unstable census). The client used to ignore that and freeze the list.
 */
const ENV_A = 'env-a'
const WORKTREE = 'repo-a::worktree-a'
const NEW_WORKTREE = 'repo-a::worktree-new'
const LEAF = '11111111-1111-4111-8111-111111111111'
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type Recorded = {
  method: string
  callbacks: Parameters<RuntimeSubscribe>[1]
  unsubscribe: ReturnType<typeof vi.fn>
}
const subscriptions: Recorded[] = []
const runtimeCall = vi.fn(async () => ({
  id: 'list-all',
  ok: true as const,
  result: { snapshots: [] },
  _meta: { runtimeId: 'runtime-a' }
}))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  const unsubscribe = vi.fn()
  subscriptions.push({ method: request.method, callbacks, unsubscribe })
  return { unsubscribe, sendBinary: vi.fn() }
})

function streams(method: string): Recorded[] {
  return subscriptions.filter((entry) => entry.method === method)
}

function terminalSnapshot(worktree: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'renderer:1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'host-surface',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-surface',
        parentTabId: 'host-tab',
        leafId: LEAF,
        title: 'Terminal',
        status: 'ready',
        terminal: 'terminal-1',
        isActive: true
      }
    ]
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
  }
}

async function deliver(entry: Recorded | undefined, response: unknown): Promise<void> {
  await act(async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test passes a complete runtime response envelope.
    entry?.callbacks.onResponse(response as Parameters<typeof entry.callbacks.onResponse>[0])
    await settle()
  })
}

async function waitOutRetry(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS + 250)
    await settle()
  })
}

describe('session-tabs streams the host ends over a live connection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscriptions.length = 0
    runtimeCall.mockClear()
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_A)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mirror reads only id, createdAt and pairingRevision.
    const runtimeEnvironments = [
      { id: ENV_A, createdAt: 100, pairingRevision: 101 }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState(
      {
        ...initialState,
        activeWorktreeId: WORKTREE,
        workspaceSessionReady: true,
        runtimeEnvironments,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mirror reads only runtimeId and connectionGeneration.
        runtimeStatusByEnvironmentId: new Map([
          [ENV_A, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
        ]) as AppState['runtimeStatusByEnvironmentId']
      },
      true
    )
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    vi.useRealTimers()
  })

  it('resubscribes the all-worktrees stream after an end frame and mirrors what the host creates next', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const first = streams('session.tabs.subscribeAll')
    expect(first).toHaveLength(1)

    await deliver(first[0], { id: 'e', ok: true, result: { type: 'end' }, _meta: {} })
    expect(first[0]!.unsubscribe).toHaveBeenCalledTimes(1)
    await waitOutRetry()

    const resubscribed = streams('session.tabs.subscribeAll')
    expect(resubscribed).toHaveLength(2)
    await deliver(resubscribed[1], {
      id: 'census',
      ok: true,
      result: { type: 'snapshots', snapshots: [terminalSnapshot(NEW_WORKTREE)] },
      _meta: { runtimeId: 'runtime-a' }
    })
    expect(useAppStore.getState().tabsByWorktree[NEW_WORKTREE]?.map((tab) => tab.id)).toEqual([
      toWebTerminalSurfaceTabId('host-tab')
    ])
  })

  it('resubscribes the active-worktree stream once after an error response, on the backoff', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const active = streams('session.tabs.subscribe')
    expect(active).toHaveLength(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await deliver(active[0], {
      id: 'err',
      ok: false,
      error: { code: 'session_tabs_inventory_unstable', message: 'unstable' },
      _meta: {}
    })
    // The errored logical subscription is dropped so reconnect replay cannot duplicate it.
    expect(active[0]!.unsubscribe).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS - 1)
      await settle()
    })
    expect(streams('session.tabs.subscribe')).toHaveLength(1)
    await waitOutRetry()
    expect(streams('session.tabs.subscribe')).toHaveLength(2)
    warn.mockRestore()
  })

  it('treats a transport error as reconnect replay territory, not an end', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await act(async () => {
      for (const entry of subscriptions) {
        entry.callbacks.onError?.({ code: 'transport', message: 'socket dropped' })
      }
      await settle()
    })
    await waitOutRetry()

    expect(subscriptions.every((entry) => entry.unsubscribe.mock.calls.length === 0)).toBe(true)
    expect(streams('session.tabs.subscribeAll')).toHaveLength(1)
    warn.mockRestore()
  })
})
