import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept } from '../../agent-hook-listener-test-harness'

const SESSION_ID = 'sess_966a9c85-10a0-4a38-8fd0-91dbeffb032b'

/**
 * Shapes captured from kiro-cli 2.27.0 (`chat --tui --v3`) running a standalone
 * `~/.kiro/hooks/*.json` file: Claude-style `hook_event_name`, `session_id`, `cwd`, plus
 * `prompt` on UserPromptSubmit and `tool_name`/`tool_input`/`tool_response` on tool events.
 */
function kiroEvent(
  hookEventName: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    hook_event_name: hookEventName,
    cwd: 'C:\\Users\\dev\\project',
    ...extra
  }
}

let state: HookListenerState
beforeEach(() => {
  state = createHookListenerState()
})

describe('Kiro hook events', () => {
  it('drops SessionStart, which Kiro fires lazily right before the first prompt', () => {
    expect(normalizeAndAccept(state, 'kiro', kiroEvent('SessionStart'))).toBeNull()
  })

  it('reports working from UserPromptSubmit and carries the prompt', () => {
    const event = normalizeAndAccept(
      state,
      'kiro',
      kiroEvent('UserPromptSubmit', { prompt: 'Run the shell command: echo probe-ok' })
    )
    expect(event?.payload).toMatchObject({
      state: 'working',
      agentType: 'kiro',
      prompt: 'Run the shell command: echo probe-ok'
    })
  })

  it('reports working for PreToolUse and names the tool', () => {
    const event = normalizeAndAccept(
      state,
      'kiro',
      kiroEvent('PreToolUse', {
        tool_name: 'execute_pwsh',
        tool_input: { command: 'echo probe-ok' }
      })
    )
    expect(event?.payload).toMatchObject({
      state: 'working',
      agentType: 'kiro',
      toolName: 'execute_pwsh'
    })
  })

  it('stays working after PostToolUse with a string tool_response', () => {
    const event = normalizeAndAccept(
      state,
      'kiro',
      kiroEvent('PostToolUse', {
        tool_name: 'execute_pwsh',
        tool_input: { command: 'echo probe-ok' },
        tool_response: 'probe-ok'
      })
    )
    expect(event?.payload).toMatchObject({ state: 'working', agentType: 'kiro' })
  })

  it('reports done on Stop and on SessionEnd', () => {
    for (const eventName of ['Stop', 'SessionEnd']) {
      const event = normalizeAndAccept(state, 'kiro', kiroEvent(eventName))
      expect(event?.payload).toMatchObject({ state: 'done', agentType: 'kiro' })
    }
  })

  it('ignores lifecycle events it does not model', () => {
    expect(normalizeAndAccept(state, 'kiro', kiroEvent('SomethingElse'))).toBeNull()
  })
})
