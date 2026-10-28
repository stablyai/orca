import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept } from '../../agent-hook-listener-test-harness'
import { isNewTurnEvent } from '../provider-event-routing'

// Payload shapes copied from a live kiro-cli 2.28 TUI run with hooks on a custom agent.
const base = { cwd: '/tmp/ws', session_id: 'f6fe70d7-a1b2-4c3d-9e8f-001122334455' }

function event(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base, hook_event_name: name, ...extra }
}

describe('normalizeKiroEvent', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('lands an idle row when the agent spawns', () => {
    const spawned = normalizeAndAccept(state, 'kiro', event('agentSpawn'))
    expect(spawned?.payload.state).toBe('done')
    expect(spawned?.payload.agentType).toBe('kiro')
  })

  it('reports a prompt as working and stop as done with the final reply', () => {
    const submitted = normalizeAndAccept(
      state,
      'kiro',
      event('userPromptSubmit', { prompt: 'read note.txt' })
    )
    expect(submitted?.payload.state).toBe('working')
    expect(submitted?.payload.prompt).toBe('read note.txt')

    const stopped = normalizeAndAccept(
      state,
      'kiro',
      event('stop', { assistant_response: 'hello' })
    )
    expect(stopped?.payload.state).toBe('done')
    expect(stopped?.payload.prompt).toBe('read note.txt')
    expect(stopped?.payload.lastAssistantMessage).toBe('hello')
  })

  it('surfaces the running tool while working', () => {
    normalizeAndAccept(state, 'kiro', event('userPromptSubmit', { prompt: 'read it' }))
    const pre = normalizeAndAccept(
      state,
      'kiro',
      event('preToolUse', {
        tool_name: 'read',
        tool_input: { operations: [{ mode: 'Line', path: '/tmp/ws/note.txt' }] }
      })
    )
    expect(pre?.payload.state).toBe('working')
    expect(pre?.payload.toolName).toBe('read')

    const post = normalizeAndAccept(
      state,
      'kiro',
      event('postToolUse', {
        tool_name: 'read',
        tool_input: { operations: [{ mode: 'Line', path: '/tmp/ws/note.txt' }] },
        tool_response: { items: [{ Text: 'hello' }] }
      })
    )
    expect(post?.payload.state).toBe('working')
  })

  it("ignores names neither engine fires, and V3's lazy SessionStart", () => {
    // Why: Kiro's docs spell V3 triggers PromptSubmit/AgentStop, but 2.27 never fires them.
    for (const name of ['PromptSubmit', 'AgentStop', 'SessionStart', 'SomethingElse']) {
      expect(normalizeAndAccept(state, 'kiro', event(name))).toBeNull()
    }
  })
})

// Shapes captured from kiro-cli 2.27.0 (`chat --tui --v3`) running Orca's standalone
// `~/.kiro/hooks/*.json` file: Claude's PascalCase names, a `sess_` id, and no final reply.
const V3_SESSION_ID = 'sess_966a9c85-10a0-4a38-8fd0-91dbeffb032b'

function v3Event(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: V3_SESSION_ID,
    hook_event_name: name,
    cwd: 'C:\\Users\\dev\\project',
    ...extra
  }
}

describe('normalizeKiroEvent with the V3 engine', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('opens a turn on UserPromptSubmit, not on the SessionStart just before it', () => {
    expect(isNewTurnEvent('kiro', 'UserPromptSubmit')).toBe(true)
    expect(isNewTurnEvent('kiro', 'SessionStart')).toBe(false)
    expect(normalizeAndAccept(state, 'kiro', v3Event('SessionStart'))).toBeNull()

    const submitted = normalizeAndAccept(
      state,
      'kiro',
      v3Event('UserPromptSubmit', { prompt: 'Run the shell command: echo probe-ok' })
    )
    expect(submitted?.payload).toMatchObject({
      state: 'working',
      agentType: 'kiro',
      prompt: 'Run the shell command: echo probe-ok'
    })
  })

  it('names the running tool and keeps a string tool_response as tool output', () => {
    normalizeAndAccept(state, 'kiro', v3Event('UserPromptSubmit', { prompt: 'echo it' }))
    const pre = normalizeAndAccept(
      state,
      'kiro',
      v3Event('PreToolUse', { tool_name: 'execute_pwsh', tool_input: { command: 'echo probe-ok' } })
    )
    expect(pre?.payload).toMatchObject({ state: 'working', toolName: 'execute_pwsh' })

    const post = normalizeAndAccept(
      state,
      'kiro',
      v3Event('PostToolUse', {
        tool_name: 'execute_pwsh',
        tool_input: { command: 'echo probe-ok' },
        tool_response: 'probe-ok'
      })
    )
    expect(post?.payload).toMatchObject({
      state: 'working',
      lastAssistantMessage: 'probe-ok',
      lastAssistantMessageIsToolOutput: true
    })
  })

  it('reports done on Stop and SessionEnd, which carry no final reply', () => {
    normalizeAndAccept(state, 'kiro', v3Event('UserPromptSubmit', { prompt: 'finish' }))
    for (const name of ['Stop', 'SessionEnd']) {
      const event = normalizeAndAccept(state, 'kiro', v3Event(name))
      expect(event?.payload).toMatchObject({ state: 'done', agentType: 'kiro', prompt: 'finish' })
    }
  })
})
