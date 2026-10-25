// Age mirrored evidence by client receipt time: rendererNow minus hostStamp gains clock skew and makes remote rows immediately stale or permanently fresh. Inject separate host/client clocks. Published freshness verdicts cannot decay during silence; exact repaints must not renew receipt time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getDefaultSettings } from '../../../shared/constants'
import { isExplicitAgentStatusFresh } from '../lib/pane-agent-evidence'
import type { AppState } from '../store/types'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { resetRendererOwnedAgentStatusPanesForTests } from '../components/terminal-pane/renderer-owned-agent-status-registry'
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

const WT = 'repo1::/path/wt1'
const ENV = 'web-env-1'
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const MIRROR_PANE_KEY = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
const T0 = 1_700_000_000_000
/** Enough skew to swamp the window in either direction. */
const HOST_SKEW_MS = AGENT_STATUS_STALE_AFTER_MS * 2

type TestStore = ReturnType<typeof createTestStore>

function hostSnapshot(args: {
  snapshotVersion: number
  hostNow: number
}): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion: args.snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${HOST_TAB_ID}::${LEAF_ID}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal' as const,
        id: `${HOST_TAB_ID}::${LEAF_ID}`,
        title: 'Claude Code',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        launchAgent: 'claude' as const,
        status: 'ready' as const,
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working' as const,
          prompt: 'run the long build',
          // Both stamps are the HOST's clock; that is the whole defect.
          updatedAt: args.hostNow,
          evidenceObservedAt: args.hostNow,
          stateStartedAt: args.hostNow - 60_000,
          agentType: 'claude',
          paneKey: makePaneKey(HOST_TAB_ID, LEAF_ID),
          tabId: HOST_TAB_ID,
          worktreeId: WT,
          stateHistory: []
        }
      }
    ]
  }
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

/** Returns false when the sync produced no state change at all (an exact repaint). */
function applyHostSnapshot(
  store: TestStore,
  hostNow: number,
  clientNow: number,
  version = 1
): boolean {
  vi.setSystemTime(clientNow)
  const state = store.getState()
  const patch = applyFreshWebSessionTabsSnapshot(
    state,
    hostSnapshot({ snapshotVersion: version, hostNow }),
    ENV,
    clientNow
  )
  if (patch === state) {
    return false
  }
  store.setState(patch as Partial<AppState>)
  return true
}

function applyChangedHostSnapshot(
  store: TestStore,
  hostNow: number,
  clientNow: number,
  version = 1
): void {
  expect(
    applyHostSnapshot(store, hostNow, clientNow, version),
    'host snapshot must reach the store'
  ).toBe(true)
}

function mirroredRowIsFreshAt(store: TestStore, clientNow: number): boolean {
  const row = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
  expect(row, 'the mirrored row must exist for freshness to mean anything').toBeDefined()
  return isExplicitAgentStatusFresh(row, clientNow, AGENT_STATUS_STALE_AFTER_MS)
}

describe('a mirrored remote row decays on the replica clock, not the host clock', () => {
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

  it('decays a row from a host running fast, instead of holding it fresh forever', () => {
    const store = seedPairedClientStore()
    applyChangedHostSnapshot(store, T0 + HOST_SKEW_MS, T0)

    expect(mirroredRowIsFreshAt(store, T0), 'fresh on arrival').toBe(true)
    expect(mirroredRowIsFreshAt(store, T0 + AGENT_STATUS_STALE_AFTER_MS + 1)).toBe(false)
  })

  it('keeps a row from a host running slow fresh for the whole window, not zero of it', () => {
    const store = seedPairedClientStore()
    applyChangedHostSnapshot(store, T0 - HOST_SKEW_MS, T0)

    expect(mirroredRowIsFreshAt(store, T0), 'must not arrive already stale').toBe(true)
    expect(mirroredRowIsFreshAt(store, T0 + AGENT_STATUS_STALE_AFTER_MS - 1_000)).toBe(true)
    expect(mirroredRowIsFreshAt(store, T0 + AGENT_STATUS_STALE_AFTER_MS + 1)).toBe(false)
  })

  it('keeps decaying while the host publishes nothing new', () => {
    // No fresh snapshot arrives during silence, so replica must age its last evidence locally.
    const store = seedPairedClientStore()
    applyChangedHostSnapshot(store, T0 + HOST_SKEW_MS, T0)

    for (const elapsed of [1_000, AGENT_STATUS_STALE_AFTER_MS / 2]) {
      expect(mirroredRowIsFreshAt(store, T0 + elapsed)).toBe(true)
    }
    expect(mirroredRowIsFreshAt(store, T0 + AGENT_STATUS_STALE_AFTER_MS * 3)).toBe(false)
  })

  it('does not restart the window when the host republishes evidence already seen', () => {
    const store = seedPairedClientStore()
    const hostNow = T0 + HOST_SKEW_MS
    applyChangedHostSnapshot(store, hostNow, T0, 1)
    // Repaint restates evidence without renewing it; neither row nor receipt should change.
    expect(
      applyHostSnapshot(store, hostNow, T0 + AGENT_STATUS_STALE_AFTER_MS - 1_000, 2),
      'an exact repaint must leave the store untouched'
    ).toBe(false)

    expect(mirroredRowIsFreshAt(store, T0 + AGENT_STATUS_STALE_AFTER_MS + 1)).toBe(false)
  })

  it('restarts the window when the host reports genuinely new evidence', () => {
    const store = seedPairedClientStore()
    applyChangedHostSnapshot(store, T0 + HOST_SKEW_MS, T0, 1)
    const laterClientNow = T0 + AGENT_STATUS_STALE_AFTER_MS - 1_000
    applyChangedHostSnapshot(store, T0 + HOST_SKEW_MS + 60_000, laterClientNow, 2)

    expect(mirroredRowIsFreshAt(store, laterClientNow + AGENT_STATUS_STALE_AFTER_MS - 1)).toBe(true)
    expect(mirroredRowIsFreshAt(store, laterClientNow + AGENT_STATUS_STALE_AFTER_MS + 1)).toBe(
      false
    )
  })
})
