import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPaneCacheState,
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'

const SESSION_ID = 'session-260501-101200-abcd'

describe('shared agent-hook-listener — Junie', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('does not open a row on SessionStart', () => {
    const event = normalizeAndAccept(state, 'junie', {
      hook_event_name: 'SessionStart',
      session_id: SESSION_ID,
      cwd: '/tmp/junie',
      source: 'startup'
    })

    // Why: Junie emits SessionStart on idle TUI open/resume; a row here would
    // spin before the user typed anything.
    expect(event).toBeNull()
  })

  it('maps the turn lifecycle to working → waiting → done', () => {
    const working = normalizeAndAccept(state, 'junie', {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      cwd: '/tmp/junie',
      prompt: 'fix the failing tests'
    })
    expect(working!.payload.state).toBe('working')
    expect(working!.payload.prompt).toBe('fix the failing tests')
    expect(working!.payload.agentType).toBe('junie')

    const tool = normalizeAndAccept(state, 'junie', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' }
    })
    expect(tool!.payload.state).toBe('working')
    expect(tool!.payload.toolName).toBe('Bash')

    const waiting = normalizeAndAccept(state, 'junie', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' }
    })
    expect(waiting!.payload.state).toBe('waiting')

    const done = normalizeAndAccept(state, 'junie', {
      hook_event_name: 'Stop',
      last_assistant_message: 'All tests pass now.'
    })
    expect(done!.payload.state).toBe('done')
  })

  it('ends the turn on StopFailure so a rate-limited turn stops spinning', () => {
    normalizeAndAccept(state, 'junie', {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      prompt: 'fix it'
    })

    const failed = normalizeAndAccept(state, 'junie', {
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      error_details: '429 Too Many Requests'
    })

    expect(failed!.payload.state).toBe('done')
  })

  it('keeps the resume session id on events that omit it', () => {
    // Junie carries session_id only on SessionStart/UserPromptSubmit; without the
    // per-pane cache, the stored `done` row would lose its resume identity.
    normalizeAndAccept(state, 'junie', {
      hook_event_name: 'SessionStart',
      session_id: SESSION_ID,
      cwd: '/tmp/junie',
      source: 'startup'
    })
    expect(state.junieSessionByPaneKey.get(PANE_KEY)).toBe(SESSION_ID)

    const tool = normalizeAndAccept(state, 'junie', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' }
    })
    expect(tool!.providerSession).toEqual({ key: 'session_id', id: SESSION_ID })

    const done = normalizeAndAccept(state, 'junie', { hook_event_name: 'Stop' })
    expect(done!.providerSession).toEqual({ key: 'session_id', id: SESSION_ID })
  })

  it('adopts a new session id when the pane starts a different session', () => {
    normalizeAndAccept(state, 'junie', {
      hook_event_name: 'SessionStart',
      session_id: SESSION_ID,
      source: 'startup'
    })
    normalizeAndAccept(state, 'junie', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-260501-120000-wxyz',
      prompt: 'second session'
    })

    const done = normalizeAndAccept(state, 'junie', { hook_event_name: 'Stop' })

    expect(done!.providerSession).toEqual({
      key: 'session_id',
      id: 'session-260501-120000-wxyz'
    })
  })

  it('does not carry a session id across a relaunch of the same pane', () => {
    // Why: a relaunch mints a new launch token. If SessionStart is ever missed for the new
    // session, the first id-less event must not inherit the old id — that would silently
    // offer `--resume` for the previous conversation.
    const post = (launchToken: string, payload: Record<string, unknown>) =>
      normalizeHookPayload(
        state,
        'junie',
        { paneKey: PANE_KEY, launchToken, payload },
        'production'
      )

    post('launch-1', {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      prompt: 'first run'
    })
    const relaunchedStop = post('launch-2', { hook_event_name: 'Stop' })

    expect(relaunchedStop!.providerSession).toBeUndefined()
  })

  it('drops the cached session id when the pane is torn down', () => {
    normalizeAndAccept(state, 'junie', {
      hook_event_name: 'SessionStart',
      session_id: SESSION_ID,
      source: 'startup'
    })

    clearPaneCacheState(state, PANE_KEY)

    expect(state.junieSessionByPaneKey.size).toBe(0)
  })
})
