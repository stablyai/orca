// A held close that expires is dropped when the host's snapshot arrives. The tab it hid must come
// back on that snapshot even when it is unchanged, not wait for the host to publish a change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS } from '../../../shared/paired-terminal-tab-close-intent'
import { useAppStore, type AppState } from '@/store'
import { appPairedTerminalTabCloseIntentStore as STORE } from './paired-terminal-tab-close-intent-store'
import {
  holdWebSessionCloseForReplay,
  resetWebSessionCloseReplaysForTests
} from './web-session-close-replay'
import { isWebSessionCloseIntentPending } from './web-session-close-intent'
import { recordReceivedWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking'
import { shouldApplyWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  makeSnapshot,
  resetWebSessionTabsSyncTestState,
  WT
} from './web-session-tabs-sync-test-harness'

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

const HOST_TAB = 'host-tab-1'
const SNAPSHOT = makeSnapshot([
  {
    type: 'terminal',
    id: HOST_SURFACE_ID,
    parentTabId: HOST_TAB,
    leafId: LEAF_ID,
    title: 'Terminal',
    status: 'ready',
    terminal: 'term_host',
    isActive: true
  }
])
const OWNER = { environmentId: ENV, pairingRevision: 1 }

let initialState: AppState

beforeEach(() => {
  initialState = useAppStore.getState()
  vi.useFakeTimers({ now: NOW })
  resetWebSessionTabsSyncTestState()
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 0, pairingRevision: 1 }])
})
afterEach(() => {
  vi.useRealTimers()
  useAppStore.setState(initialState, true)
  resetWebSessionCloseReplaysForTests()
  resetWebSessionTabsSyncTestState()
  replaceRuntimeEnvironmentRevisions([])
})

describe('an expired held paired-host close', () => {
  it('lets the unchanged snapshot that dropped it redraw the tab', () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, [HOST_TAB])
    // The tab is hidden when this snapshot applies.
    expect(shouldApplyWebSessionTabsSnapshot(SNAPSHOT, ENV)).toBe(true)
    expect(isWebSessionCloseIntentPending(OWNER, WT, HOST_TAB, Date.now())).toBe(true)

    vi.setSystemTime(NOW + PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS + 1)
    recordReceivedWebSessionTabsSnapshot(ENV, SNAPSHOT)

    expect(useAppStore.getState().pairedTerminalTabCloseIntentsByEnvironment[ENV]).toBeUndefined()
    expect(isWebSessionCloseIntentPending(OWNER, WT, HOST_TAB, Date.now())).toBe(false)
    expect(shouldApplyWebSessionTabsSnapshot(SNAPSHOT, ENV)).toBe(true)
  })

  it('redraws another worktree whose expired close the same drop pruned', () => {
    const otherWorktree = 'repo::/other'
    const otherSnapshot = { ...SNAPSHOT, worktree: otherWorktree }
    holdWebSessionCloseForReplay(STORE, OWNER, WT, [HOST_TAB])
    holdWebSessionCloseForReplay(STORE, OWNER, otherWorktree, [HOST_TAB])
    expect(shouldApplyWebSessionTabsSnapshot(SNAPSHOT, ENV)).toBe(true)
    expect(shouldApplyWebSessionTabsSnapshot(otherSnapshot, ENV)).toBe(true)

    vi.setSystemTime(NOW + PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS + 1)
    recordReceivedWebSessionTabsSnapshot(ENV, SNAPSHOT)

    expect(useAppStore.getState().pairedTerminalTabCloseIntentsByEnvironment[ENV]).toBeUndefined()
    expect(isWebSessionCloseIntentPending(OWNER, otherWorktree, HOST_TAB, Date.now())).toBe(false)
    expect(shouldApplyWebSessionTabsSnapshot(otherSnapshot, ENV)).toBe(true)
  })

  it('still refuses an unchanged snapshot when nothing was un-hidden', () => {
    expect(shouldApplyWebSessionTabsSnapshot(SNAPSHOT, ENV)).toBe(true)
    recordReceivedWebSessionTabsSnapshot(ENV, SNAPSHOT)
    expect(shouldApplyWebSessionTabsSnapshot(SNAPSHOT, ENV)).toBe(false)
  })
})
