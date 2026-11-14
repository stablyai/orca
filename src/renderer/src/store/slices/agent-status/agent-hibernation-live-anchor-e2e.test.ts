import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '../../types'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/testing/terminal-tab.test-fixture'
import { DEFAULT_AGENT_HIBERNATION_IDLE_MS } from '../../../lib/agent-session/hibernation/agent-hibernation-planner'
import { resetHibernationPaneAgeForTests } from '../../../lib/agent-session/hibernation/agent-hibernation-pane-age'

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

describe('a finished Claude turn retains its live status timing', () => {
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
    expect(state.agentStatusByPaneKey[PANE]?.updatedAt).toBe(NOW - 1_000)
    expect(state.agentStatusByPaneKey[PANE]?.stateStartedAt).toBe(DONE_AT)
  })
})
