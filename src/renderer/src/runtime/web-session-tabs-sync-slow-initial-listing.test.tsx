// @vitest-environment happy-dom

// A paired host's first tab listing can take longer than the client waits for it: on the first
// boot after an upgrade the host derives its chats' statuses before it answers. The listing's
// timeout must not leave the client without the host's tabs. The all-worktrees stream, open since
// the same moment, delivers the host's full inventory as its first frame once the host is ready.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'

const mocks = vi.hoisted(() => ({
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn(),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKeys: () => ({
    environmentKey: mocks.runtimeSessionMirrorEnvironmentKey(),
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
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverSnapshot
}))

import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { AppState } from '@/store/types'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'

const ENV_A = 'env-a'
const WORKTREE = 'repo-a::worktree-a'
const REVISION_A = 101
const MIRROR_KEY = `${ENV_A}\u0001runtime-a\u00011\u0001${REVISION_A}`
const initialState = useAppStore.getInitialState()

type RuntimeCall = typeof window.api.runtimeEnvironments.call
type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
}

const subscriptions: RuntimeSubscription[] = []
// The listing in flight, answered by the test: here, only ever by the client's own timeout.
let answerListing: (response: RuntimeRpcResponse<unknown>) => void = () => {}
const runtimeCall = vi.fn<RuntimeCall>(
  (request) =>
    new Promise((resolve) => {
      if (request.method === 'session.tabs.listAll') {
        answerListing = resolve
      }
    })
)
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  subscriptions.push({ request, callbacks })
  return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
})

function chatSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'structured:epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: 'agent-session:codex-1',
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:codex-1',
        title: 'Codex Chat',
        sessionId: 'codex-1',
        agent: 'codex',
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

function inventoryStream(): RuntimeSubscription {
  const stream = subscriptions.find(
    ({ request }) => request.method === 'session.tabs.subscribeAll' && request.selector === ENV_A
  )
  if (!stream) {
    throw new Error('the all-worktrees stream was never opened')
  }
  return stream
}

const mirroredChats = () =>
  (useAppStore.getState().unifiedTabsByWorktree[WORKTREE] ?? []).filter(
    (tab) => tab.contentType === 'agent-session'
  )

describe('a paired host whose first tab listing outlasts the client', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_A)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mirror scan and revision ledger read only id, createdAt and pairingRevision.
    const runtimeEnvironments = [
      { id: ENV_A, createdAt: 100, pairingRevision: REVISION_A }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState(
      {
        ...initialState,
        activeWorktreeId: WORKTREE,
        workspaceSessionReady: true,
        runtimeEnvironments,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mirror reads only runtimeId and connectionGeneration from each status.
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
  })

  it("still mirrors the host's chats from the stream after the listing times out", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.listAll', timeoutMs: 15_000 })
    )
    const stream = inventoryStream()

    // 15 s pass with the host still deriving: the client gives up on its listing.
    await act(async () => {
      answerListing({
        id: 'list-all',
        ok: false,
        error: {
          code: 'runtime_timeout',
          message: 'Timed out waiting for the remote Orca runtime response.'
        },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })
    expect(mirroredChats()).toEqual([])

    // The host finishes: the stream's first frame is its whole inventory.
    await act(async () => {
      stream.callbacks.onResponse({
        id: 'subscription-event',
        ok: true,
        result: { type: 'snapshots', snapshots: [chatSnapshot()], authoritative: true },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    expect(mirroredChats().map((tab) => tab.entityId)).toEqual(['codex-1'])
    // Nothing retried the listing: the stream alone carried the tabs.
    expect(
      runtimeCall.mock.calls.filter(([request]) => request.method === 'session.tabs.listAll')
    ).toHaveLength(1)
  })
})
