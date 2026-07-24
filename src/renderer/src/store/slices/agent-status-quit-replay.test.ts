import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

const PANE_KEY = 'tab-1:leaf-1'
const PROVIDER_SESSION = { key: 'session_id' as const, id: 'codex-session-1' }

function seedQuitRecoveryRecord(): {
  store: ReturnType<typeof createTestStore>
  record: SleepingAgentSessionRecord
} {
  const store = createTestStore()
  const record: SleepingAgentSessionRecord = {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: PROVIDER_SESSION,
    prompt: 'finish the task',
    state: 'done',
    capturedAt: 200,
    updatedAt: 100,
    origin: 'quit'
  }
  store.setState({
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
    },
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
  } as Partial<AppState>)
  return { store, record }
}

function applyDoneStatus(
  store: ReturnType<typeof createTestStore>,
  updatedAt: number,
  providerSession = PROVIDER_SESSION
): void {
  store.getState().setAgentStatus(
    PANE_KEY,
    {
      state: 'done',
      prompt: 'finish the task',
      agentType: 'codex',
      lastAssistantMessage: 'Task complete'
    },
    'Codex',
    { updatedAt, stateStartedAt: updatedAt },
    { tabId: 'tab-1', worktreeId: 'wt-1' },
    { providerSession }
  )
}

describe('quit recovery record replay', () => {
  it('preserves a quit record when startup replays an older matching done snapshot', () => {
    const { store, record } = seedQuitRecoveryRecord()

    applyDoneStatus(store, 100)

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBe(record)
  })

  it('clears the quit record for a newer done event', () => {
    const { store } = seedQuitRecoveryRecord()

    applyDoneStatus(store, 201)

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('clears the quit record when the replay belongs to another provider session', () => {
    const { store } = seedQuitRecoveryRecord()

    applyDoneStatus(store, 100, { key: 'session_id', id: 'codex-session-2' })

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
  })
})
