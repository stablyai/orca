import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

const PANE_KEY = 'tab-1:leaf-1'
const WORKER_SESSION = { key: 'session_id' as const, id: 'codex-session-1' }

function seedWorkingWorker(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
  } as Partial<AppState>)
  store
    .getState()
    .setAgentStatus(
      PANE_KEY,
      { state: 'working', prompt: 'review the diff', agentType: 'codex' },
      'Codex',
      { updatedAt: 10, stateStartedAt: 10 },
      undefined,
      { providerSession: WORKER_SESSION }
    )
  return store
}

describe('settled orchestration worker automatic-resume fence', () => {
  it('keeps the fence when the worker turn finishes after settlement', () => {
    const store = seedWorkingWorker()
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeDefined()

    // The dispatch settles (worker_done) while the turn is still reported as working.
    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true)
    expect(
      store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'done', prompt: 'review the diff', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 20 },
        undefined,
        { providerSession: WORKER_SESSION }
      )

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record?.state).toBe('done')
    expect(record?.automaticResumeBlockedBy).toBe('legacy-orchestration-worker')
  })

  it('keeps the fence when a periodic capture follows a status ping', () => {
    const store = seedWorkingWorker()
    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true)

    // The turn still reads `working` after settlement, so a status ping only moves `updatedAt` and
    // leaves the stored checkpoint stale — which is exactly what makes the 60s capture re-derive it.
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'review the diff', agentType: 'codex' },
        'Codex',
        { updatedAt: 15, stateStartedAt: 10 },
        undefined,
        { providerSession: WORKER_SESSION }
      )
    store.getState().captureAllSleepingAgentSessions('periodic')

    expect(
      store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
  })

  it('keeps the fence when the pane re-registers its launch config', () => {
    const store = seedWorkingWorker()
    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true)

    // A daemon reattach re-registers the pane's effective launch config, which refreshes the record.
    store
      .getState()
      .registerAgentLaunchConfig(
        PANE_KEY,
        { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        { agentType: 'codex', tabId: 'tab-1', leafId: 'leaf-1' }
      )

    expect(
      store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
  })

  it('does not carry the fence onto a different provider session on the same pane', () => {
    const store = seedWorkingWorker()
    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true)

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'done', prompt: 'a new user turn', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 20 },
        undefined,
        { providerSession: { key: 'session_id', id: 'codex-session-2' } }
      )

    expect(
      store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.automaticResumeBlockedBy
    ).toBeUndefined()
  })
})
