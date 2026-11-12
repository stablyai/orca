import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '../../types'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/terminal-tab.test-fixture'
import {
  DEFAULT_AGENT_HIBERNATION_IDLE_MS,
  planAgentHibernationCandidates
} from '../../../lib/agent-session/hibernation/agent-hibernation-planner'
import {
  getHibernationBoundaryResolvedAtByPaneKey,
  resetHibernationPaneAgeForTests
} from '../../../lib/agent-session/hibernation/agent-hibernation-pane-age'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const DONE_AT = 1_000_000
const NOW = DONE_AT + DEFAULT_AGENT_HIBERNATION_IDLE_MS + 60_000
const ROUTING = { tabId: 'tab-1', worktreeId: 'wt-bg', connectionId: null }
const PROVIDER_SESSION = { key: 'session_id' as const, id: 'claude-session-1' }

function seedWorkspace(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    activeWorktreeId: 'wt-active',
    tabsByWorktree: { 'wt-bg': [makeTab({ id: 'tab-1', worktreeId: 'wt-bg' })] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    }
  } as unknown as Partial<AppState>)
}

function planFrom(state: AppState, ptyBindingFirstSeenAt: number): string[] {
  return planAgentHibernationCandidates({
    settings: state.settings,
    activeWorktreeId: state.activeWorktreeId,
    foregroundTerminalTabIds: [],
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    inUsePtyIds: [],
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    lastTerminalInputAtByPaneKey: {},
    foregroundTerminalLastSeenAtByTabId: {},
    ptyBindingFirstSeenAtByPaneKey: { [PANE]: ptyBindingFirstSeenAt },
    boundaryResolvedAtByPaneKey: getHibernationBoundaryResolvedAtByPaneKey(),
    now: NOW
  }).map((candidate) => candidate.paneKey)
}

describe('a finished Claude turn reaches the hibernation planner', () => {
  beforeEach(() => {
    resetHibernationPaneAgeForTests()
  })

  it('is not restarted by a done→done repaint carrying a fresh updatedAt', () => {
    const store = createTestStore()
    seedWorkspace(store)
    for (const timing of [
      { updatedAt: DONE_AT - 5_000, stateStartedAt: DONE_AT - 5_000 },
      { updatedAt: DONE_AT, stateStartedAt: DONE_AT }
    ]) {
      store.getState().setAgentStatus(
        PANE,
        {
          state: timing.updatedAt === DONE_AT ? 'done' : 'working',
          prompt: 'ship it',
          agentType: 'claude'
        },
        'Claude',
        timing,
        ROUTING,
        { providerSession: PROVIDER_SESSION }
      )
    }
    // Metadata-less reconnect/OSC repaint refreshes updatedAt but preserves original stateStartedAt.
    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'done', prompt: 'ship it', agentType: 'claude' },
        'Claude',
        { updatedAt: NOW - 1_000, stateStartedAt: DONE_AT },
        ROUTING
      )
    const state = store.getState()
    expect(state.agentStatusByPaneKey.get(PANE)?.updatedAt).toBe(NOW - 1_000)
    expect(state.agentStatusByPaneKey.get(PANE)?.stateStartedAt).toBe(DONE_AT)
    expect(planFrom(state, DONE_AT)).toEqual([PANE])
  })

  it('stamps boundaryResolvedAt when a boundary done becomes a real completion', () => {
    const store = createTestStore()
    seedWorkspace(store)
    store.getState().setAgentStatus(
      PANE,
      {
        state: 'done',
        prompt: 'ship it',
        agentType: 'claude',
        sessionBoundary: true
      },
      'Claude',
      { updatedAt: DONE_AT, stateStartedAt: DONE_AT },
      ROUTING,
      { providerSession: PROVIDER_SESSION }
    )
    expect(getHibernationBoundaryResolvedAtByPaneKey()[PANE]).toBeUndefined()

    // Assistant evidence clears boundary flag without moving stateStartedAt; completion stamp is the only new signal.
    store.getState().setAgentStatus(
      PANE,
      {
        state: 'done',
        prompt: 'ship it',
        agentType: 'claude',
        lastAssistantMessage: 'done and pushed'
      },
      'Claude',
      { updatedAt: NOW - 1_000, stateStartedAt: DONE_AT },
      ROUTING,
      { providerSession: PROVIDER_SESSION }
    )
    expect(getHibernationBoundaryResolvedAtByPaneKey()[PANE]).toBe(NOW - 1_000)
    // Ancient stateStartedAt, but the completion just happened — must not sleep yet.
    expect(planFrom(store.getState(), DONE_AT)).toEqual([])
  })
})
