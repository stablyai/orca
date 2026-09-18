/**
 * S-status-authority: buildMirroredAgentStatusPatch's right-hand merge arm
 * (`existing.updatedAt > entry.updatedAt`) let an UNOWNED client row outrank
 * the host purely on wall-clock comparison — no ownership requirement at all.
 * agent-status-patch.ts:31-44/110-113 already say cross-machine wall clocks
 * are not comparable; this suite pins the contract that follows from that:
 * a host row is replaced only by a proven, fresh, client-owned row the host
 * does not pierce, never by wall-clock alone. See docs/reference/
 * agent-status-store.md ("Precedence is decided once, at write time... /
 * Readers never re-adjudicate").
 *
 * Harness reused from web-session-tabs-sync-remote-status-title-flap.test.ts:
 * seedPairedClientStore + makeHostSnapshot + applyHostSnapshot shape, and the
 * renderer-owned-agent-status-registry helpers for the ownership claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
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
import {
  applyWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests,
  shouldApplyWebSessionTabsSnapshot
} from './web-session-tabs-sync'

const WT = 'repo1::/path/wt1'
const ENV = 'web-env-1'
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HOST_SURFACE_ID = `${HOST_TAB_ID}::${LEAF_ID}`
const MIRROR_TAB_ID = toWebTerminalSurfaceTabId(HOST_TAB_ID)
const MIRROR_PANE_KEY = makePaneKey(MIRROR_TAB_ID, LEAF_ID)
const HOST_PANE_KEY = makePaneKey(HOST_TAB_ID, LEAF_ID)
const T0 = 1_700_000_000_000

type TestStore = ReturnType<typeof createTestStore>

function makeHostSnapshot(args: {
  snapshotVersion: number
  hostNow: number
  agentStatusOverrides: Partial<AgentStatusEntry>
}): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion: args.snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: HOST_SURFACE_ID,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'Terminal',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working' as const,
          prompt: '',
          updatedAt: args.hostNow,
          stateStartedAt: args.hostNow - 1_000,
          agentType: 'claude' as const,
          paneKey: HOST_PANE_KEY,
          tabId: HOST_TAB_ID,
          worktreeId: WT,
          stateHistory: [],
          ...args.agentStatusOverrides
        }
      }
    ]
  }
}

function applyHostSnapshot(
  store: TestStore,
  snapshot: RuntimeMobileSessionTabsResult,
  now: number
): void {
  const state = store.getState()
  expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)
  const patch = applyWebSessionTabsSnapshot(state, snapshot, ENV, now)
  store.setState(patch as Partial<AppState>)
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

/** Writes a client-side row directly, exactly like an OSC/hook write would, but WITHOUT
 *  claiming the renderer-owned-agent-status-registry fence — an unproven writer. */
function writeUnownedClientRow(store: TestStore, updatedAt: number): void {
  store
    .getState()
    .setAgentStatus(
      MIRROR_PANE_KEY,
      { state: 'working', prompt: 'stale client work', agentType: 'claude' },
      'claude',
      { updatedAt },
      { tabId: MIRROR_TAB_ID, worktreeId: WT }
    )
}

describe('S-status-authority: a host row is never outranked by a client wall clock alone', () => {
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

  it('a host blocked row is never outranked by a client row with a later wall clock', () => {
    const store = seedPairedClientStore()
    const hostNow = T0
    // Client row's wall clock is 60s AHEAD of the host's, but the client never
    // proved ownership of this pane (no registry claim) — an unproven writer.
    writeUnownedClientRow(store, hostNow + 60_000)
    expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')

    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostNow,
        agentStatusOverrides: {
          state: 'blocked',
          prompt: 'Allow Bash(rm -rf)?',
          interactivePrompt: 'Allow Bash(rm -rf)?'
        }
      }),
      hostNow + 1_000
    )

    expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('blocked')
  })

  it('an unowned client row never outranks the host by wall clock', () => {
    const store = seedPairedClientStore()
    const hostNow = T0
    // Client row's wall clock is later than the host's 'done' row, but again
    // carries no ownership claim.
    writeUnownedClientRow(store, hostNow + 60_000)
    expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')

    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostNow,
        agentStatusOverrides: { state: 'done', prompt: '' }
      }),
      hostNow + 1_000
    )

    expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('done')
  })

  it('a proven, fresh, client-owned row still keeps its state when the host does not pierce', () => {
    const store = seedPairedClientStore()
    const hostNow = T0
    // Anchor for the fence: this IS a proven, fresh client writer, so the fence
    // still holds — unlike the two unowned cases above.
    registerRendererOwnedAgentStatusPane(MIRROR_PANE_KEY, ENV)
    markRendererOwnedAgentStatusWrite(MIRROR_PANE_KEY)
    store
      .getState()
      .setAgentStatus(
        MIRROR_PANE_KEY,
        { state: 'working', prompt: 'live client work', agentType: 'claude' },
        'claude',
        { updatedAt: hostNow + 60_000 },
        { tabId: MIRROR_TAB_ID, worktreeId: WT }
      )

    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostNow,
        agentStatusOverrides: { state: 'done', prompt: '' }
      }),
      hostNow + 1_000
    )

    expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')
  })
})
