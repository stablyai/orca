/**
 * A paired client mirrors the host's agent rows from `session.tabs` with no per-field parser, so a
 * verdict arm the client's build does not know reaches its store as-is. The row must survive and
 * read as the done it always did; the arms this build knows read as their own mark.
 *
 * Runs the real host-snapshot mirror, the real store and the real sidebar row builder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { AgentTurnOutcome } from '../../../shared/agent-turn-outcome'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getDefaultSettings } from '../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { resetRendererOwnedAgentStatusPanesForTests } from '../components/terminal-pane/renderer-owned-agent-status-registry'
import {
  applyFreshWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'
import { buildWorktreeAgentRows } from '../components/sidebar/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree
} from '../components/sidebar/worktree-agent-row-selectors'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../components/sidebar/worktree-card-status-inputs'

// Why: web-session-tabs-sync imports the app-level store singleton; this drives a test store.
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
const HOST_TAB = 'host-tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'

function hostSnapshot(outcome: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: `${HOST_TAB}::${LEAF}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${HOST_TAB}::${LEAF}`,
        title: 'Claude Code',
        parentTabId: HOST_TAB,
        leafId: LEAF,
        isActive: true,
        launchAgent: 'claude',
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'done',
          prompt: '',
          updatedAt: T0 - 1_000,
          stateStartedAt: T0 - 2_000,
          agentType: 'claude',
          paneKey: makePaneKey(HOST_TAB, LEAF),
          tabId: HOST_TAB,
          worktreeId: WT,
          stateHistory: [],
          mainAgent: {
            state: 'done',
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host frame is unparsed here, so it can carry an arm this build cannot name.
            outcome: outcome as AgentTurnOutcome,
            stateStartedAt: T0 - 2_000
          }
        }
      }
    ]
  }
}

/** The sidebar rows the paired client renders after mirroring one host frame. */
function mirroredRows(outcome: string) {
  const store = createTestStore()
  seedStore(store, {
    settings: getDefaultSettings('/tmp'),
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  const state = store.getState()
  store.setState(applyFreshWebSessionTabsSnapshot(state, hostSnapshot(outcome), ENV, T0))
  const next = store.getState()
  const tabs = next.tabsByWorktree[WT] ?? []
  return buildWorktreeAgentRows({
    tabs,
    entries: selectLiveAgentStatusEntriesForWorktree(next, WT),
    retained: selectRetainedAgentEntriesForWorktree(next, WT),
    runtimePaneTitlesByTabId: selectRuntimePaneTitlesForWorktree(next, WT),
    ptyIdsByTabId: selectLivePtyIdsForWorktree(next, WT),
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [tab.id, next.terminalLayoutsByTabId[tab.id]])
    ),
    now: T0
  }).filter((row) => row.paneKey === makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB), LEAF))
}

describe('a paired client mirroring a host verdict arm', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a row whose outcome it cannot name, and reads it done', () => {
    const [row, ...rest] = mirroredRows('from-a-newer-host')
    expect(rest).toEqual([])
    expect(row?.state).toBe('done')
    expect(row && agentVerdictDisplayMark({ ...row.entry, acknowledgedAt: undefined })).toBeNull()
  })

  it.each([
    ['interruption', 'failed'],
    ['unconfirmed', 'unconfirmed']
  ] as const)('reads a mirrored %s as its own mark', (outcome, mark) => {
    const [row] = mirroredRows(outcome)
    expect(row && agentVerdictDisplayMark({ ...row.entry, acknowledgedAt: undefined })).toBe(mark)
  })
})
