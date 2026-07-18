import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

const PANE_KEY = 'tab-1:leaf-1'
const PROVIDER_SESSION = { key: 'session_id' as const, id: 'codex-session-1' }

function seedCompletedCodex(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
  } as Partial<AppState>)
  store
    .getState()
    .setAgentStatus(
      PANE_KEY,
      { state: 'done', prompt: 'finish the task', agentType: 'codex' },
      'Codex',
      { updatedAt: 20, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: PROVIDER_SESSION }
    )
}

describe('completed agent conversation recovery', () => {
  it('keeps a completed turn as passive recovery identity across quit capture', () => {
    const store = createTestStore()
    seedCompletedCodex(store)

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex',
      providerSession: PROVIDER_SESSION,
      state: 'done',
      origin: 'completed'
    })

    store.getState().captureAllSleepingAgentSessions('quit')

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      agent: 'codex',
      providerSession: PROVIDER_SESSION,
      state: 'done',
      origin: 'completed'
    })
  })

  it('replaces an active checkpoint with passive recovery when the turn completes', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    } as Partial<AppState>)

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'finish the task', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: PROVIDER_SESSION }
      )
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.origin).toBe('live')

    seedCompletedCodex(store)

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      providerSession: PROVIDER_SESSION,
      state: 'done',
      origin: 'completed'
    })
  })

  it('clears recovery identity after confirmed agent exit', () => {
    const store = createTestStore()
    seedCompletedCodex(store)

    store.getState().dropAgentStatus(PANE_KEY)

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('does not retain an interrupted completed turn', () => {
    const store = createTestStore()
    seedCompletedCodex(store)

    store.getState().setAgentStatus(
      PANE_KEY,
      {
        state: 'done',
        prompt: 'finish the task',
        agentType: 'codex',
        interrupted: true
      },
      'Codex',
      { updatedAt: 30, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: PROVIDER_SESSION }
    )

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
  })
})
