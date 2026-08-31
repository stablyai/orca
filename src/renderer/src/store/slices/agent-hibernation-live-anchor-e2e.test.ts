import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'
import {
  DEFAULT_AGENT_HIBERNATION_IDLE_MS,
  planAgentHibernationCandidates
} from '../../lib/agent-hibernation-planner'
import {
  getHibernationBoundaryResolvedAtByPaneKey,
  resetHibernationPaneAgeForTests
} from '../../lib/agent-hibernation-pane-age'

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
    mobileLockedPtyIds: [],
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

  // Why: #10238 broadened the live recovery anchor to every resumable agent but left the
  // planner's exemption Pi-only, so the two halves disagreed and no Claude pane could sleep.
  // This pins the seam, not either half alone.
  it('writes a live resume anchor that no longer blocks it', () => {
    const store = createTestStore()
    seedWorkspace(store)
    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'working', prompt: 'summarize the diff', agentType: 'claude' },
        'Claude',
        { updatedAt: DONE_AT - 5_000, stateStartedAt: DONE_AT - 5_000 },
        ROUTING,
        { providerSession: PROVIDER_SESSION }
      )
    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'done', prompt: 'summarize the diff', agentType: 'claude' },
        'Claude',
        { updatedAt: DONE_AT, stateStartedAt: DONE_AT },
        ROUTING,
        { providerSession: PROVIDER_SESSION }
      )

    const state = store.getState()
    expect(state.agentStatusByPaneKey[PANE]?.state).toBe('done')
    expect(state.sleepingAgentSessionsByPaneKey[PANE]).toMatchObject({
      agent: 'claude',
      origin: 'live'
    })
    expect(planFrom(state, DONE_AT)).toEqual([PANE])
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
    // A metadata-less redelivery: main resends `done` with a fresh updatedAt and the
    // ORIGINAL stateStartedAt, exactly as an OSC 9999 repaint or reconnect replay does.
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
    expect(state.agentStatusByPaneKey[PANE]?.updatedAt).toBe(NOW - 1_000)
    expect(state.agentStatusByPaneKey[PANE]?.stateStartedAt).toBe(DONE_AT)
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

    // Assistant evidence proves a REAL completion; the store clears the boundary flag in
    // place without advancing stateStartedAt, so the stamp is the only signal of it.
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
