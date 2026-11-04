import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from '../listener-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { PANE_KEY } from './agent-hook-listener-test-harness'

/** OMP emits approval only after policy decides to prompt, so every request means a blocked human. Ambient approval_mode (even yolo) cannot override per-tool prompts or downgrade waiting (STA-7698). */
describe('OMP approval ownership', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function post(
    agentType: 'omp' | 'pi',
    payload: Record<string, unknown>
  ): ReturnType<typeof normalizeHookPayload> {
    return normalizeHookPayload(state, agentType, { paneKey: PANE_KEY, payload }, 'production')
  }

  /** Normalizes the post and admits its row, as the hook server does, so the next post sees it. */
  function deliver(payload: Record<string, unknown>): string {
    const event = post('omp', payload)
    if (event) {
      seedLegacyAgentStatusForTests(state, event)
    }
    return state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state ?? 'none'
  }

  // The order omp 17 posted for a denied bash call, captured off a live run's extension events.
  it('keeps the approval wait through the tool_execution_start omp posts right after it', () => {
    expect(deliver({ hook_event_name: 'tool_call', tool_name: 'bash' })).toBe('working')
    expect(
      deliver({
        hook_event_name: 'tool_approval_requested',
        tool_name: 'bash',
        approval_mode: 'always-ask'
      })
    ).toBe('blocked')
    expect(deliver({ hook_event_name: 'tool_execution_start', tool_name: 'bash' })).toBe('blocked')
    expect(
      deliver({ hook_event_name: 'tool_approval_resolved', tool_name: 'bash', approved: false })
    ).toBe('working')
    expect(deliver({ hook_event_name: 'tool_execution_end', tool_name: 'bash' })).toBe('working')
    expect(deliver({ hook_event_name: 'agent_end' })).toBe('done')
  })
})
