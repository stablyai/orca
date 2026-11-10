// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/workspace-layout/stable-pane-id'
import '../../../../../shared/workspace-layout/terminal-surface-id'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/viewport/visibility/stale-document-visibility'
import type * as WebRuntimeTerminalCreationModule from '../../hosted-terminals/creation/web-runtime-terminal-creation'

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  ownerEnvironmentIdForWorkspace: vi.fn(),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKeys: () => ({
    environmentKey: mocks.runtimeSessionMirrorEnvironmentKey(),
    resubscribeSignal: ''
  })
}))

vi.mock('../mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (state: unknown, workspaceId: string | null) =>
    workspaceId ? (mocks.ownerEnvironmentIdForWorkspace(state, workspaceId) ?? null) : null
}))

vi.mock('../../hosted-terminals/recovery/web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverSnapshot
}))

vi.mock('../../hosted-terminals/creation/web-runtime-terminal-creation', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeTerminalCreationModule>()
  return {
    ...actual,
    createWebRuntimeSessionTerminal: mocks.createTerminal
  }
})

import { useAppStore } from '@/store/index'
import '@/store/slices/editor/file-ids/editor-file-ids'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'
import '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import '../terminal-handles/web-session-terminal-handle-events'
import {
  _getWebSessionTabsReceiptTrackingCountsForTest,
  _getWebSessionTabsTrackingCountsForTest,
  resetWebSessionTabsSnapshotFreshnessForTests
} from '../tracking-lifecycle'
import { useWebSessionTabsSync } from '../use-web-session-tabs-sync'
import '../state'
import '../../../lib/window-activity/window-park-visibility'
import {
  connectedRuntimeStatus,
  publicRuntimeEnvironment
} from '../../rpc/testing/paired-runtime-environment-test-fixture'

const ENV_A = 'env-a'
const ENV_B = 'env-b'
const WORKTREE = 'repo-a::worktree-a'
const REVISION_A = 101
const REVISION_B = 201
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const MIRROR_KEY = `${ENV_A}\u0001runtime-a\u00011\u0001${REVISION_A}\u0000${ENV_B}\u0001runtime-b\u00012\u0001${REVISION_B}`
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
  unsubscribe: ReturnType<typeof vi.fn>
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const subscriptions: RuntimeSubscription[] = []
const runtimeCall = vi.fn(async () => ({
  id: 'list-all',
  ok: true as const,
  result: { snapshots: [] },
  _meta: { runtimeId: 'runtime-test' }
}))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  const unsubscribe = vi.fn()
  subscriptions.push({ request, callbacks, unsubscribe })
  return { unsubscribe, sendBinary: vi.fn() }
})

function createDeferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function makeTerminalSnapshot(
  idSuffix: string,
  snapshotVersion = 1
): RuntimeMobileSessionTabsResult {
  const parentTabId = `host-tab${idSuffix}`
  const leafId = idSuffix === '-a' ? LEAF_A : LEAF_B
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: `host-group${idSuffix}`,
    activeTabId: `host-surface${idSuffix}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `host-surface${idSuffix}`,
        parentTabId,
        leafId,
        title: `Terminal ${idSuffix}`,
        status: 'ready',
        terminal: `terminal${idSuffix}`,
        isActive: true,
        agentStatus: {
          state: 'working',
          prompt: 'build',
          updatedAt: 100,
          stateStartedAt: 90,
          agentType: 'codex',
          paneKey: `${parentTabId}:${leafId}`,
          tabId: parentTabId,
          worktreeId: WORKTREE,
          stateHistory: []
        }
      }
    ]
  }
}

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function findActiveSubscription(environmentId: string, occurrence = 0): RuntimeSubscription {
  const matches = subscriptions.filter(
    ({ request }) =>
      request.method === 'session.tabs.subscribe' && request.selector === environmentId
  )
  const subscription = matches[occurrence]
  if (!subscription) {
    throw new Error(`Missing active subscription ${occurrence} for ${environmentId}`)
  }
  return subscription
}

async function publish(subscription: RuntimeSubscription, result: unknown): Promise<void> {
  await act(async () => {
    subscription.callbacks.onResponse({
      id: 'subscription-event',
      ok: true,
      result,
      _meta: { runtimeId: 'runtime-test' }
    })
    await settle()
  })
}

function seedRemoteMirrorState(): void {
  const runtimeEnvironments = [
    publicRuntimeEnvironment({ id: ENV_A, createdAt: 100, pairingRevision: REVISION_A }),
    publicRuntimeEnvironment({ id: ENV_B, createdAt: 200, pairingRevision: REVISION_B })
  ]
  replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
  useAppStore.setState(
    {
      ...initialState,
      activeWorktreeId: WORKTREE,
      workspaceSessionReady: true,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map([
        [ENV_A, connectedRuntimeStatus('runtime-a', 1)],
        [ENV_B, connectedRuntimeStatus('runtime-b', 2)]
      ])
    },
    true
  )
}

describe('useWebSessionTabsSync visibility collision recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset().mockResolvedValue(undefined)
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.ownerEnvironmentIdForWorkspace.mockReset().mockReturnValue(ENV_A)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    setDocumentVisibility('visible')
    resetWebSessionTabsSnapshotFreshnessForTests()
    seedRemoteMirrorState()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetStaleDocumentVisibilityForTesting()
    setDocumentVisibility('visible')
    vi.useRealTimers()
  })

  it('does not let old cleanup erase a new recovery generation', async () => {
    const oldRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => oldRecovery.promise)
    const oldHook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeTerminalSnapshot('-a')
    await publish(findActiveSubscription(ENV_A), { type: 'snapshot', ...snapshot })
    oldHook.unmount()

    const newRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => newRecovery.promise)
    const newHook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findActiveSubscription(ENV_A, 1), { type: 'snapshot', ...snapshot })

    // A recovery started by an unmounted generation must not write the store it no longer owns.
    oldRecovery.resolve(snapshot)
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]).toBeUndefined()

    newRecovery.resolve(snapshot)
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.length).toBe(1)
    newHook.unmount()
  })
})
