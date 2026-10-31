// Persist unheard paired closes across reload or the next host snapshot restores closed tabs forever (STA-6224).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { useAppStore, type AppState } from '@/store'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from '@/lib/session-write-subscriber'
import { closeWebRuntimeSessionTab } from './web-runtime-session-tab-lifecycle'
import { resetWebSessionCloseReplaysForTests } from './web-session-close-replay'
import { recordReceivedWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

const LOCAL_TAB_ID = toWebTerminalSurfaceTabId('host-tab-1')
const SURFACE = {
  type: 'terminal' as const,
  id: HOST_SURFACE_ID,
  parentTabId: 'host-tab-1',
  leafId: LEAF_ID,
  title: 'Terminal',
  status: 'ready' as const,
  terminal: 'term_host',
  isActive: true
}
const PAIRED = [{ id: ENV, createdAt: 0, pairingRevision: 1 }]

let initialState: AppState
let runtimeCall: ReturnType<typeof vi.fn>

function closeCalls(): unknown[] {
  return runtimeCall.mock.calls.flatMap(([request]: unknown[]) =>
    typeof request === 'object' &&
    request !== null &&
    'method' in request &&
    request.method === 'session.tabs.close'
      ? [request]
      : []
  )
}

function shownTabIds(): string[] {
  const snapshot = makeSnapshot([SURFACE])
  recordReceivedWebSessionTabsSnapshot(ENV, snapshot)
  const patch = applyWebSessionTabsSnapshot(makeState(), snapshot, ENV, NOW)
  return (patch.tabsByWorktree?.[WT] ?? []).map((tab) => tab.id)
}

beforeEach(() => {
  initialState = useAppStore.getState()
  vi.useFakeTimers({ now: NOW })
  resetWebSessionTabsSyncTestState()
  replaceRuntimeEnvironmentRevisions(PAIRED)
  runtimeCall = vi.fn().mockResolvedValue({ id: 'ok', ok: true, result: { closed: true } })
  stubRuntimeEnvironmentBridge({ call: runtimeCall })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
  resetWebSessionCloseReplaysForTests()
  replaceRuntimeEnvironmentRevisions([])
})

describe('a held paired-host close across a reload', () => {
  it('still hides the tab after the reload and sends the close once the pairing is known', async () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })
    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    persist.mockClear()
    // The user's close never reaches the host.
    runtimeCall.mockRejectedValueOnce(new Error('socket hang up'))
    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WT,
        tabId: LOCAL_TAB_ID,
        environmentId: ENV,
        reason: 'user'
      })
    ).resolves.toBe('failed')
    vi.advanceTimersByTime(200)
    cleanup()
    const saved = JSON.parse(
      JSON.stringify(
        Object.assign(getDefaultWorkspaceSession(), ...persist.mock.calls.map(([w]) => w.patch))
      )
    )

    // Reload loses in-memory state; saved closes must work before environment pairings arrive.
    resetWebSessionTabsSyncTestState()
    resetWebSessionCloseReplaysForTests()
    replaceRuntimeEnvironmentRevisions([])
    useAppStore.setState(initialState, true)
    const parsed = parseWorkspaceSession(saved)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    useAppStore.getState().hydrateWorkspaceSession(parsed.value)
    const closesBeforeReload = closeCalls().length

    expect(shownTabIds()).not.toContain(LOCAL_TAB_ID)
    await vi.advanceTimersByTimeAsync(0)
    expect(closeCalls()).toHaveLength(closesBeforeReload)

    replaceRuntimeEnvironmentRevisions(PAIRED)
    expect(shownTabIds()).not.toContain(LOCAL_TAB_ID)
    await vi.waitFor(() => expect(closeCalls()).toHaveLength(closesBeforeReload + 1))
    expect(closeCalls().at(-1)).toMatchObject({
      params: { tabId: 'host-tab-1', reason: 'user' },
      expectedEnvironmentPairingRevision: 1
    })
  })
})
