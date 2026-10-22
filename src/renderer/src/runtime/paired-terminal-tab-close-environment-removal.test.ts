// A removed server can never take a held close, so its closes go with it instead of waiting out
// the 30-day bound in the saved session, including a server removed while the app was closed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS,
  type PairedTerminalTabCloseIntent
} from '../../../shared/paired-terminal-tab-close-intent'
import { useAppStore, type AppState } from '@/store'
import { resetDeferredPeerChecksForTests } from '@/store/slices/runtime-environment-peer-replacement'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { appPairedTerminalTabCloseIntentStore as STORE } from './paired-terminal-tab-close-intent-store'
import {
  holdWebSessionCloseForReplay,
  resetWebSessionCloseReplaysForTests,
  takeDueWebSessionCloseReplays
} from './web-session-close-replay'
import {
  isWebSessionCloseIntentPending,
  recordWebSessionCloseIntent
} from './web-session-close-intent'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))
const refreshSnapshot = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: refreshSnapshot
}))

const WT = 'repo::/wt'
const TAB = 'host-tab-1'

function environment(
  id: string,
  overrides: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    ...overrides,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: `ws-${id}`, kind: 'websocket', label: id, endpoint: `wss://${id}` }],
    preferredEndpointId: `ws-${id}`
  }
}

function managed(id: string, pairingRevision: number, hostKeyFingerprint?: string) {
  return environment(id, {
    pairingRevision,
    hostKeyFingerprint,
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: 46_768,
      remotePort: 6_768
    }
  })
}

function heldClose(): PairedTerminalTabCloseIntent {
  return { hostTabIds: [TAB], worktreeId: WT, closedAt: Date.now(), pairingRevision: 1 }
}

/** A user close the host never received: held, and its tab hidden. */
function hold(environmentId: string): void {
  holdWebSessionCloseForReplay(STORE, { environmentId, pairingRevision: 1 }, WT, [TAB])
}

function hidden(environmentId: string, pairingRevision: number): boolean {
  return isWebSessionCloseIntentPending({ environmentId, pairingRevision }, WT, TAB, Date.now())
}

function heldRevisions(environmentId: string): (number | undefined)[] | undefined {
  return useAppStore
    .getState()
    .pairedTerminalTabCloseIntentsByEnvironment[environmentId]?.map(
      (intent) => intent.pairingRevision
    )
}

let initialState: AppState

beforeEach(() => {
  initialState = useAppStore.getState()
})
afterEach(() => {
  vi.useRealTimers()
  useAppStore.setState(initialState, true)
  replaceRuntimeEnvironmentRevisions([])
  resetDeferredPeerChecksForTests()
  resetWebSessionCloseReplaysForTests()
  resetWebSessionTabsSyncTestState()
})

describe('held paired-host closes when a server is removed', () => {
  it("drops the removed server's closes, un-hiding its tab, and keeps the others'", () => {
    useAppStore.getState().setRuntimeEnvironments([environment('env-a'), environment('env-b')])
    hold('env-a')
    hold('env-b')

    useAppStore.getState().setRuntimeEnvironments([environment('env-b')])

    expect(heldRevisions('env-a')).toBeUndefined()
    expect(hidden('env-a', 1)).toBe(false)
    expect(heldRevisions('env-b')).toEqual([1])
    expect(hidden('env-b', 1)).toBe(true)
  })

  it('drops the closes of a server whose re-pair proves it is another machine', () => {
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 1, 'key-a')])
    hold('env-a')

    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 2, 'key-reinstalled')])

    expect(heldRevisions('env-a')).toBeUndefined()
    expect(hidden('env-a', 1)).toBe(false)
  })

  it("moves the saved closes to a managed server's same-machine re-pair, so a reload sends them", () => {
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 1, 'key-a')])
    hold('env-a')

    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 2, 'key-a')])

    expect(heldRevisions('env-a')).toEqual([2])
    expect(hidden('env-a', 1)).toBe(false)
    expect(hidden('env-a', 2)).toBe(true)
    // The reload: the in-memory continuation is gone, but the saved close already names pairing 2.
    replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 2 }])
    const due = takeDueWebSessionCloseReplays(STORE, 'env-a', WT, new Set([TAB]))
    expect(due.map((replay) => replay.owner)).toEqual([
      { environmentId: 'env-a', pairingRevision: 2 }
    ])
  })

  it("holds a managed re-pair's closes, unsent, until its host key decides the machine", async () => {
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 1, 'key-a')])
    hold('env-a')
    // The re-pair lands before the catalog carries the host's key.
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 2)])

    expect(takeDueWebSessionCloseReplays(STORE, 'env-a', WT, new Set([TAB]))).toEqual([])
    expect(heldRevisions('env-a')).toEqual([1])
    expect(hidden('env-a', 2)).toBe(true)

    refreshSnapshot.mockClear()
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 2, 'key-a')])

    expect(heldRevisions('env-a')).toEqual([2])
    // An idle host may publish nothing more, so the decision itself asks for the snapshot.
    await vi.waitFor(() =>
      expect(refreshSnapshot).toHaveBeenCalledWith('env-a', WT, {
        expectedEnvironmentPairingRevision: 2
      })
    )
    const due = takeDueWebSessionCloseReplays(STORE, 'env-a', WT, new Set([TAB]))
    expect(due.map((replay) => replay.owner)).toEqual([
      { environmentId: 'env-a', pairingRevision: 2 }
    ])
    // Once moved, a later catalog has nothing to move and asks for nothing.
    refreshSnapshot.mockClear()
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 2, 'key-a')])
    await Promise.resolve()
    expect(refreshSnapshot).not.toHaveBeenCalled()
  })

  it('keeps holding through a second undecided re-pair and moves them to the newest one', () => {
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 1, 'key-a')])
    hold('env-a')
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 2)])
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 3)])
    expect(takeDueWebSessionCloseReplays(STORE, 'env-a', WT, new Set([TAB]))).toEqual([])

    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 3, 'key-a')])

    expect(heldRevisions('env-a')).toEqual([3])
  })

  it('drops the held closes once the late host key proves another machine', () => {
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 1, 'key-a')])
    hold('env-a')
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 2)])
    expect(takeDueWebSessionCloseReplays(STORE, 'env-a', WT, new Set([TAB]))).toEqual([])

    expect(hidden('env-a', 2)).toBe(true)

    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 2, 'key-reinstalled')])

    expect(heldRevisions('env-a')).toBeUndefined()
    expect(hidden('env-a', 2)).toBe(false)
    expect(takeDueWebSessionCloseReplays(STORE, 'env-a', WT, new Set([TAB]))).toEqual([])
  })

  it('shows the tab again when a close held through an undecided re-pair expires', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 1, 'key-a')])
    hold('env-a')
    useAppStore.getState().setRuntimeEnvironments([managed('env-a', 2)])
    expect(takeDueWebSessionCloseReplays(STORE, 'env-a', WT, new Set([TAB]))).toEqual([])
    vi.setSystemTime(Date.now() + PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS + 1)

    expect(takeDueWebSessionCloseReplays(STORE, 'env-a', WT, new Set([TAB]))).toEqual([])

    expect(heldRevisions('env-a')).toBeUndefined()
    expect(hidden('env-a', 2)).toBe(false)
  })

  it("dropping an old pairing's close leaves a fresh close of the same tab hidden", () => {
    useAppStore.getState().setRuntimeEnvironments([environment('env-a')])
    hold('env-a')
    replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 2 }])
    // The user closes the tab again under the new pairing; that close is still in flight.
    recordWebSessionCloseIntent({ environmentId: 'env-a', pairingRevision: 2 }, WT, TAB, Date.now())

    expect(takeDueWebSessionCloseReplays(STORE, 'env-a', WT, new Set([TAB]))).toEqual([])

    expect(heldRevisions('env-a')).toBeUndefined()
    expect(hidden('env-a', 2)).toBe(true)
  })

  it('drops, at the first catalog, the closes of a server removed while the app was closed', () => {
    useAppStore.getState().hydrateWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      pairedTerminalTabCloseIntentsByEnvironment: { 'env-a': [heldClose()], 'env-b': [heldClose()] }
    })

    useAppStore.getState().setRuntimeEnvironments([environment('env-b')])

    expect(Object.keys(useAppStore.getState().pairedTerminalTabCloseIntentsByEnvironment)).toEqual([
      'env-b'
    ])
  })

  it('drops them at session restore when the catalog published first', () => {
    useAppStore.getState().setRuntimeEnvironments([environment('env-b')])

    useAppStore.getState().hydrateWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      pairedTerminalTabCloseIntentsByEnvironment: { 'env-a': [heldClose()], 'env-b': [heldClose()] }
    })

    expect(Object.keys(useAppStore.getState().pairedTerminalTabCloseIntentsByEnvironment)).toEqual([
      'env-b'
    ])
  })
})
