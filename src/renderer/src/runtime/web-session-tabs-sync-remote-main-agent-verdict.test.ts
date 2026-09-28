/**
 * A paired client mirrors a host's agent rows from `session.tabs`. A main agent that fails while
 * its subagents keep the row working changes nothing but `mainAgent`: the row's state, start and
 * (within one host frame) update time all stay put. The mirror must still take the new row and
 * invalidate the worktree rollup, which caches on the agent-status epoch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { AgentMainAgentStatus } from '../../../shared/main-agent-status'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getDefaultSettings } from '../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { resetRendererOwnedAgentStatusPanesForTests } from '../components/terminal-pane/renderer-owned-agent-status-registry'
import {
  applyFreshWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'
import { selectWorktreeAgentActivitySummary } from '../components/sidebar/worktree-agent-activity-summary'

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
const ENV = 'remote-env-1'
const T0 = 1_700_000_000_000
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function hostSnapshot(snapshotVersion: number, mainAgent: AgentMainAgentStatus) {
  const snapshot: RuntimeMobileSessionTabsResult = {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${HOST_TAB_ID}::${LEAF_ID}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${HOST_TAB_ID}::${LEAF_ID}`,
        title: 'Claude Code',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        launchAgent: 'claude',
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: 'ship it',
          updatedAt: T0 - 1_000,
          stateStartedAt: T0 - 5_000,
          agentType: 'claude',
          paneKey: makePaneKey(HOST_TAB_ID, LEAF_ID),
          tabId: HOST_TAB_ID,
          worktreeId: WT,
          stateHistory: [],
          mainAgent
        }
      }
    ]
  }
  return snapshot
}

describe('a mirrored main agent that fails while its subagents keep the row working', () => {
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

  it('reaches the store and the worktree rollup', () => {
    const store = createTestStore()
    seedStore(store, {
      settings: getDefaultSettings('/tmp'),
      worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
      activeWorktreeId: WT
    })
    const apply = (snapshot: RuntimeMobileSessionTabsResult): void => {
      store.setState(applyFreshWebSessionTabsSnapshot(store.getState(), snapshot, ENV, T0))
    }

    apply(hostSnapshot(1, { state: 'working', stateStartedAt: T0 - 5_000 }))
    expect(selectWorktreeAgentActivitySummary(store.getState(), WT)).toMatchObject({
      hasLiveWorking: true,
      hasFailed: false
    })

    apply(hostSnapshot(2, { state: 'done', outcome: 'failure', stateStartedAt: T0 - 2_000 }))
    const paneKey = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
    expect(store.getState().agentStatusByPaneKey[paneKey]?.mainAgent?.outcome).toBe('failure')
    expect(selectWorktreeAgentActivitySummary(store.getState(), WT)).toMatchObject({
      hasLiveWorking: false,
      hasFailed: true
    })
  })
})
