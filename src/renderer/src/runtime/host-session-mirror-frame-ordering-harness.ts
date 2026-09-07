import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
import { useAppStore, type AppState } from '@/store'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import {
  BG_MIRROR_TAB_ID,
  BG_WT,
  ENV,
  frameOrderingMocks as mocks,
  LEAF_ID,
  makeWorktree,
  MIRROR_KEY,
  MIRROR_TAB_ID,
  mirrorTabRow,
  REPO_ID,
  REVISION,
  WT
} from './host-session-mirror-frame-fixtures'
import { resetHostSessionMirrorHydrationForTests } from './host-session-mirror-hydration'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync'

const initialState = useAppStore.getInitialState()

export type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
export type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
}

export const subscriptions: RuntimeSubscription[] = []
// Why: a resolved listAll would settle the mirror on its own and hide the race.
export const runtimeCall = vi.fn((_request: { method: string }) => new Promise(() => {}))
export const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  subscriptions.push({ request, callbacks })
  return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
})

export async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

export function seedState(): void {
  const runtimeEnvironments = [
    { id: ENV, createdAt: 100, pairingRevision: REVISION }
  ] as PublicKnownRuntimeEnvironment[]
  replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
  const worktrees = [
    makeWorktree(WT, '/workspace/feature'),
    makeWorktree(BG_WT, '/workspace/background')
  ]
  useAppStore.setState(
    {
      ...initialState,
      repos: [
        {
          id: REPO_ID,
          path: '/workspace/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0
        }
      ],
      worktreesByRepo: { [REPO_ID]: worktrees },
      activeRepoId: REPO_ID,
      activeWorktreeId: WT,
      activeView: 'terminal',
      workspaceSessionReady: true,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map([
        [ENV, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
      ]) as AppState['runtimeStatusByEnvironmentId'],
      // Mirror rows the host published before the app restarted; no live PTY
      // handles yet, which is precisely why liveness is unknowable right now.
      tabsByWorktree: {
        [WT]: [mirrorTabRow(MIRROR_TAB_ID, WT)],
        [BG_WT]: [mirrorTabRow(BG_MIRROR_TAB_ID, BG_WT)]
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        [MIRROR_TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-host-old-1' }
        },
        [BG_MIRROR_TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-host-old-2' }
        }
      },
      settings: { agentCmdOverrides: {}, setupScriptLaunchMode: 'new-tab' }
    } as never,
    true
  )
}

export function seedSleepingRecord(tabId: string, worktreeId: string, sessionId: string): string {
  const paneKey = makePaneKey(tabId, LEAF_ID)
  useAppStore.setState((s) => ({
    sleepingAgentSessionsByPaneKey: {
      ...s.sleepingAgentSessionsByPaneKey,
      [paneKey]: {
        paneKey,
        tabId,
        worktreeId,
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: sessionId },
        prompt: 'keep working',
        state: 'working' as const,
        origin: 'live' as const,
        capturedAt: 1000,
        updatedAt: 1000,
        terminalTitle: 'Codex'
      }
    }
  }))
  return paneKey
}

export function findSubscription(method: string, occurrence = 0): RuntimeSubscription {
  const subscription = subscriptions.filter(({ request }) => request.method === method)[occurrence]
  if (!subscription) {
    throw new Error(`Missing ${method} subscription ${occurrence}`)
  }
  return subscription
}

export function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

export async function publish(
  subscription: RuntimeSubscription,
  result: unknown,
  runtimeId = 'runtime-a'
): Promise<void> {
  await act(async () => {
    subscription.callbacks.onResponse({
      id: 'subscription-event',
      ok: true as const,
      result,
      _meta: { runtimeId }
    } as never)
    await settle()
  })
}

export function tabIds(worktreeId: string): string[] {
  return (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
}

/** A drained waiter has to land a claiming replacement tab; a replay that only
 *  consumed the record launched nothing. */
export function expectReplayedResume(paneKey: string, worktreeId: string, sessionId: string): void {
  const state = useAppStore.getState()
  expect(state.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  const claimedTabIds = Object.keys(state.automaticAgentResumeClaimsByTabId)
  expect(claimedTabIds).toHaveLength(1)
  const replacementTabId = claimedTabIds[0]!
  expect(replacementTabId).not.toBe(MIRROR_TAB_ID)
  expect(tabIds(worktreeId)).toContain(replacementTabId)
  expect(state.automaticAgentResumeClaimsByTabId[replacementTabId]).toMatchObject({
    launchAgent: 'codex',
    providerSession: { key: 'session_id', id: sessionId }
  })
}

/** Registers the shared harness reset for the receipt-era describe blocks. */
export function installFrameOrderingHarness(options: { fakeTimers?: boolean } = {}): void {
  beforeEach(() => {
    if (options.fakeTimers) {
      vi.useFakeTimers()
    }
    subscriptions.length = 0
    runtimeCall.mockClear().mockImplementation(() => new Promise(() => {}))
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset().mockResolvedValue(undefined)
    mocks.queueAcceptedSnapshot.mockReset()
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    if (options.fakeTimers) {
      setDocumentVisibility('visible')
    }
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetHostSessionMirrorHydrationForTests()
    setRuntimeEnvironmentConnectionGenerationForTests(ENV, 1)
    seedState()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetHostSessionMirrorHydrationForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    if (options.fakeTimers) {
      resetStaleDocumentVisibilityForTesting()
      setDocumentVisibility('visible')
      vi.useRealTimers()
    }
  })
}
