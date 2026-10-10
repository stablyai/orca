/**
 * #22445: switching Orca tabs unmounts a pane, and pty-connection's disposer
 * cedes renderer ownership of that pane's agent status back to the host. The
 * next mirrored host snapshot that carries no status for the surface then hit
 * buildMirroredAgentStatusPatch's delete loop, which was gated only on
 * ownership — so a genuine unanswered question was deleted, not retired, and
 * vanished from the sidebar because the user looked at another tab.
 *
 * Invariant pinned here: absence of host status is not a resolution. A still
 * fresh `waiting`/`blocked` row survives the ownership handover and retires the
 * same way an owned row does — by decaying past the freshness boundary — while
 * every other state keeps the pre-existing delete behavior.
 *
 * Injected at the real seam: real snapshot mirror, real renderer-ownership
 * registry, real store. Time is driven, never the oracle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-freshness'
import type { AgentStatusState } from '../../../shared/agent-status-types'
import { getDefaultSettings } from '../../../shared/constants'
import {
  createTestStore,
  makeWorktree,
  seedStore,
  type TestAppStore
} from '../store/slices/store-test-helpers'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import {
  applyFreshWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'

// Why: web-session-tabs-sync imports the app-level store singleton; this
// harness drives a createTestStore instance instead, like its sibling suites.
vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

const WT = 'repo1::/path/wt1'
const ENV = 'web-env-1'
const HOST_EPOCH = 'host-epoch-1'
const T0 = 1_700_000_000_000

const HOST_TAB = 'host-tab-claude'
const LEAF = '11111111-1111-4111-8111-111111111111'

const MIRROR_TAB_ID = toWebTerminalSurfaceTabId(HOST_TAB)
const PANE_KEY = makePaneKey(MIRROR_TAB_ID, LEAF)

/** A hook-only host publishes the surface but no agentStatus for it — the shape
 *  that reaches the delete loop after ownership goes back to the host.
 *  `hostState` models the other kind of pane: one the host itself minted status
 *  for, where a later snapshot without status is the host withdrawing it. */
function makeHostSnapshot(
  snapshotVersion: number,
  hostState?: AgentStatusState,
  hostNow = 0
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: HOST_EPOCH,
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${HOST_TAB}::${LEAF}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal' as const,
        id: `${HOST_TAB}::${LEAF}`,
        title: 'Claude',
        parentTabId: HOST_TAB,
        leafId: LEAF,
        isActive: true,
        launchAgent: 'claude',
        status: 'ready' as const,
        terminal: 'terminal-1',
        ...(hostState
          ? {
              agentStatus: {
                state: hostState,
                prompt: 'May I edit src/app.ts?',
                updatedAt: hostNow,
                stateStartedAt: hostNow,
                agentType: 'claude' as const,
                paneKey: makePaneKey(HOST_TAB, LEAF),
                tabId: HOST_TAB,
                worktreeId: WT,
                stateHistory: []
              }
            }
          : {})
      }
    ]
  }
}

function applyHostSnapshot(
  store: TestAppStore,
  snapshotVersion: number,
  now: number,
  hostState?: AgentStatusState
): void {
  vi.setSystemTime(now)
  const patch = applyFreshWebSessionTabsSnapshot(
    store.getState(),
    makeHostSnapshot(snapshotVersion, hostState, now),
    ENV,
    now
  )
  store.setState(patch)
}

/** Byte-identical replay of pty-connection on a paired runtime: claim the pane
 *  at transport creation, prove the byte-derived write, then hand back what the
 *  unmount disposer calls via releaseRendererOwnedAgentStatusPane(). */
function replayClientByteStatus(
  store: TestAppStore,
  state: AgentStatusState,
  clientNow: number
): () => void {
  vi.setSystemTime(clientNow)
  const release = registerRendererOwnedAgentStatusPane(PANE_KEY, ENV)
  markRendererOwnedAgentStatusWrite(PANE_KEY)
  store
    .getState()
    .setAgentStatus(
      PANE_KEY,
      { state, prompt: 'May I edit src/app.ts?', agentType: 'claude' },
      'claude',
      undefined,
      {
        tabId: MIRROR_TAB_ID,
        worktreeId: WT
      }
    )
  return release
}

function seedPairedClientStore(): TestAppStore {
  const store = createTestStore()
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  return store
}

describe('unmounting a pane does not delete an unresolved agent blocker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  it.each(['waiting', 'blocked'] as const)(
    'keeps a fresh %s row after the unmount hands ownership back to a host that reports no status',
    (state) => {
      const store = seedPairedClientStore()
      applyHostSnapshot(store, 1, T0)
      const release = replayClientByteStatus(store, state, T0 + 1_000)
      expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.state).toBe(state)

      release()
      applyHostSnapshot(store, 2, T0 + 2_000)

      expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.state).toBe(state)
    }
  )

  it('still deletes the row once the unanswered blocker decays past the freshness boundary', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(store, 1, T0)
    const release = replayClientByteStatus(store, 'waiting', T0 + 1_000)

    release()
    applyHostSnapshot(store, 2, T0 + 1_000 + AGENT_STATUS_STALE_AFTER_MS + 1)

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('control: a finished turn is still deleted on the same handover', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(store, 1, T0)
    const release = replayClientByteStatus(store, 'done', T0 + 1_000)

    release()
    applyHostSnapshot(store, 2, T0 + 2_000)

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('a host-minted blocker the host stops publishing is still deleted at once', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(store, 1, T0, 'waiting')
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.state).toBe('waiting')

    // The host dismissed the row (dropAgentStatus) or closed the leaf: it still
    // publishes the surface, just without status. That is a withdrawal, not
    // silence, so the reader owes it no retention.
    applyHostSnapshot(store, 2, T0 + 1_000)

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toBeUndefined()
  })
})
