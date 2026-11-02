// Client OSC ownership once discarded mirrored lastAssistantMessage, which only host hooks know (#12906/STA-3596). OSC writes lack that field, so wholesale client precedence blanked every paired row. Drive real mirror/store/sidebar builder and assert entry.lastAssistantMessage, the field both row renderers consume.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '../store/types'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import { buildWorktreeAgentRows } from '../components/sidebar/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree
} from '../components/sidebar/worktree-agent-row-selectors'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../components/sidebar/worktree-card-status-inputs'

// Mock singleton import; this harness drives createTestStore like sibling mirror suites.
vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

const WT = 'repo1::/path/wt1'
const ENV = 'remote-env-1'
const HOST_EPOCH = 'host-epoch-1'
const T0 = 1_700_000_000_000

/** The pane this renderer streams and therefore claims (pty-connection claims
 *  every pane whose transport has a runtimeEnvironmentId). */
const OWNED = {
  hostTabId: 'host-tab-1',
  leafId: '11111111-1111-4111-8111-111111111111'
} as const
/** A pane mirrored from the same host that this renderer never wrote status for,
 *  so the host stays authoritative for it. */
const CEDED = {
  hostTabId: 'host-tab-2',
  leafId: '22222222-2222-4222-8222-222222222222'
} as const

const HOST_MESSAGE = '좌→우 가로 파이프라인으로 다시 그렸습니다'

type PaneRef = { hostTabId: string; leafId: string }

function mirrorTabId(pane: PaneRef): string {
  return toWebTerminalSurfaceTabId(pane.hostTabId)
}

function mirrorPaneKey(pane: PaneRef): string {
  return makePaneKey(mirrorTabId(pane), pane.leafId)
}

type HostPaneStatus = {
  state: 'working' | 'done'
  /** Omitted entirely for the old-host skew case. */
  lastAssistantMessage?: string
  stateStartedAt: number
}

function makeHostSnapshot(args: {
  snapshotVersion: number
  hostNow: number
  statusByHostTabId: Record<string, HostPaneStatus>
}): RuntimeMobileSessionTabsResult {
  const panes: PaneRef[] = [OWNED, CEDED]
  return {
    worktree: WT,
    publicationEpoch: HOST_EPOCH,
    snapshotVersion: args.snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${OWNED.hostTabId}::${OWNED.leafId}`,
    activeTabType: 'terminal',
    tabs: panes.map((pane, index) => {
      const status = args.statusByHostTabId[pane.hostTabId]
      return {
        type: 'terminal' as const,
        id: `${pane.hostTabId}::${pane.leafId}`,
        title: 'Claude Code',
        parentTabId: pane.hostTabId,
        leafId: pane.leafId,
        isActive: index === 0,
        launchAgent: 'claude' as const,
        status: 'ready' as const,
        terminal: `terminal-${index + 1}`,
        ...(status
          ? {
              agentStatus: {
                state: status.state,
                prompt: '',
                updatedAt: args.hostNow,
                stateStartedAt: status.stateStartedAt,
                agentType: 'claude' as const,
                paneKey: makePaneKey(pane.hostTabId, pane.leafId),
                tabId: pane.hostTabId,
                worktreeId: WT,
                stateHistory: [],
                ...(status.lastAssistantMessage !== undefined
                  ? { lastAssistantMessage: status.lastAssistantMessage }
                  : {})
              }
            }
          : {})
      }
    })
  }
}

type TestStore = ReturnType<typeof createTestStore>

/** Mirrors applyWebSessionTabsStorePatch: build the patch from live state, then
 *  set it. Returns false when the mirror produced no change — pre-fix, a
 *  republication onto a client-owned pane is exactly that no-op. */
function applyHostSnapshot(
  store: TestStore,
  snapshot: RuntimeMobileSessionTabsResult,
  now: number
): boolean {
  vi.setSystemTime(now)
  const state = store.getState()
  const patch = applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, now)
  store.setState(patch as Partial<AppState>)
  return patch !== state
}

/**
 * Byte-identical replay of what pty-connection does for a remote pane: claim the
 * key at transport creation, then prove the claim with a byte-derived write. The
 * OSC pipeline sees a title and a state — never a Stop event — so the payload it
 * writes carries no lastAssistantMessage.
 */
function replayClientByteStatus(
  store: TestStore,
  pane: PaneRef,
  state: 'working' | 'done',
  clientNow: number
): void {
  vi.setSystemTime(clientNow)
  const paneKey = mirrorPaneKey(pane)
  registerRendererOwnedAgentStatusPane(paneKey, ENV)
  markRendererOwnedAgentStatusWrite(paneKey)
  store
    .getState()
    .setAgentStatus(paneKey, { state, prompt: '', agentType: 'claude' }, 'Claude Code', undefined, {
      tabId: mirrorTabId(pane),
      worktreeId: WT
    })
}

function seedPairedClientStore(): TestStore {
  const store = createTestStore()
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  } as Partial<AppState>)
  return store
}

/** The value both agent-row renderers read, keyed by pane. Byte-identical to
 *  useWorktreeAgentRows' inputs, minus React. */
function observeRowMessages(store: TestStore, now: number): Record<string, string | undefined> {
  const state = store.getState()
  const tabs = state.tabsByWorktree[WT] ?? []
  const rows = buildWorktreeAgentRows({
    tabs,
    entries: selectLiveAgentStatusEntriesForWorktree(state, WT),
    retained: selectRetainedAgentEntriesForWorktree(state, WT),
    runtimePaneTitlesByTabId: selectRuntimePaneTitlesForWorktree(state, WT),
    ptyIdsByTabId: selectLivePtyIdsForWorktree(state, WT),
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [tab.id, state.terminalLayoutsByTabId[tab.id]])
    ),
    now
  })
  const byPaneKey: Record<string, string | undefined> = {}
  for (const row of rows) {
    if (row.rowSource !== 'subagent') {
      byPaneKey[row.paneKey] = row.entry.lastAssistantMessage
    }
  }
  return byPaneKey
}

describe('#12906: remote agent rows keep the host-published last assistant message', () => {
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

  it('keeps a mirrored message when a later host frame omits the field (old host / new client)', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostNow: T0 - 1_000,
        statusByHostTabId: {
          [OWNED.hostTabId]: { state: 'done', stateStartedAt: T0 - 2_000 }
        }
      }),
      T0
    )
    replayClientByteStatus(store, OWNED, 'done', T0)
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 2,
        hostNow: T0 + 1_000,
        statusByHostTabId: {
          [OWNED.hostTabId]: {
            state: 'done',
            lastAssistantMessage: HOST_MESSAGE,
            stateStartedAt: T0 - 2_000
          }
        }
      }),
      T0 + 2_000
    )
    expect(
      observeRowMessages(store, T0 + 2_000)[mirrorPaneKey(OWNED)],
      'precondition: the fenced pane adopted the host message'
    ).toBe(HOST_MESSAGE)

    // Older hosts can drop message when stale status demotes under neutral titles (#9914); do not blank retained text.
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 3,
        hostNow: T0 + 3_000,
        statusByHostTabId: {
          [OWNED.hostTabId]: { state: 'done', stateStartedAt: T0 - 2_000 }
        }
      }),
      T0 + 4_000
    )

    expect(observeRowMessages(store, T0 + 4_000)[mirrorPaneKey(OWNED)]).toBe(HOST_MESSAGE)
  })

  it('does not paste last turn’s message under a turn the client already restarted', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostNow: T0 - 10_000,
        statusByHostTabId: {
          [OWNED.hostTabId]: {
            state: 'done',
            lastAssistantMessage: HOST_MESSAGE,
            stateStartedAt: T0 - 20_000
          }
        }
      }),
      T0 - 9_000
    )
    // Spinner starts a new turn before host hook catches up; its done frame belongs to the previous turn.
    replayClientByteStatus(store, OWNED, 'working', T0)
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 2,
        hostNow: T0 + 1_000,
        statusByHostTabId: {
          [OWNED.hostTabId]: {
            state: 'done',
            lastAssistantMessage: HOST_MESSAGE,
            stateStartedAt: T0 - 20_000
          }
        }
      }),
      T0 + 2_000
    )

    // Local writes replace lastAssistantMessage directly, so starting a new turn clears completion text.
    const messages = observeRowMessages(store, T0 + 2_000)
    expect(Object.keys(messages)).toContain(mirrorPaneKey(OWNED))
    expect(messages[mirrorPaneKey(OWNED)]).toBeUndefined()
  })
})
