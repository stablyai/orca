import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  producerCacheKey,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { seedClaudeLeadTurnFromPersistedStatus } from './agent-hook-listener/providers/claude-roster-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

// The pane's row was written by Claude; a nested agent's normalizer must not treat it as its own history.
describe("a nested agent's normalizer ignores another agent's row", () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
    seedLegacyAgentStatusForTests(state, {
      paneKey: PANE_KEY,
      source: 'claude',
      connectionId: null,
      payload: {
        state: 'working',
        prompt: 'claude task',
        agentType: 'claude',
        mainAgent: { state: 'working', stateStartedAt: 1 }
      }
    })
  })

  it("starts OpenCode's main-agent clock fresh", () => {
    const event = normalizeHookPayload(
      state,
      'opencode',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'SessionBusy', root_state: 'working' } },
      'production'
    )
    expect(event?.payload.mainAgent?.state).toBe('working')
    expect(event?.payload.mainAgent?.stateStartedAt).toBeGreaterThan(1)
  })

  it("does not restate Claude's row as a Pi model switch", () => {
    // A Claude event committed onto a Pi pane keeps the Pi label but carries Claude's prompt.
    seedLegacyAgentStatusForTests(state, {
      paneKey: PANE_KEY,
      source: 'claude',
      connectionId: null,
      payload: { state: 'done', prompt: 'claude task', agentType: 'pi' }
    })
    const event = normalizeHookPayload(
      state,
      'pi',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'model_select', model: 'a/b' } },
      'production'
    )
    expect(event).toBeNull()
  })

  it.each([
    ['claude', 'claude task'],
    ['codex', undefined]
  ] as const)('seeds Claude from a saved row only when Claude wrote it (%s)', (source, prompt) => {
    const fresh = createHookListenerState()
    seedClaudeLeadTurnFromPersistedStatus(fresh, PANE_KEY, {
      source,
      claudeRunningNonAgentTask: false,
      payload: {
        state: 'done',
        prompt: 'claude task',
        agentType: 'claude',
        mainAgent: { state: 'done', stateStartedAt: 1 }
      }
    })
    expect(fresh.lastPromptByProducerKey.get(producerCacheKey(PANE_KEY, 'claude'))).toBe(prompt)
    expect(fresh.claudeLeadStateByPaneKey.has(PANE_KEY)).toBe(source === 'claude')
  })
})
