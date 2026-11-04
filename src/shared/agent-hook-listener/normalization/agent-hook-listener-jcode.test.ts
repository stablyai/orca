import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { PANE_KEY } from './agent-hook-listener-test-harness'

function ingest(state: HookListenerState, payload: Record<string, unknown>) {
  return normalizeHookPayload(
    state,
    'jcode',
    { paneKey: PANE_KEY, payload: { hook_event_name: payload.event, ...payload } },
    'production'
  )
}

describe('shared agent-hook-listener: jcode', () => {
  let state: HookListenerState
  let jcodeHome: string

  beforeEach(() => {
    jcodeHome = mkdtempSync(join(tmpdir(), 'orca-jcode-hooks-'))
    vi.stubEnv('JCODE_HOME', jcodeHome)
    state = createHookListenerState()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(jcodeHome, { recursive: true, force: true })
  })

  it('keeps the pre_tool input visible when post_tool reports completion', () => {
    ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_1',
      tool_name: 'bash',
      tool_input: '{"command":"pnpm test","intent":"Run the suite"}'
    })
    const event = ingest(state, {
      event: 'post_tool',
      session_id: 'session_jc_1',
      tool_name: 'bash',
      status: 'ok',
      duration_ms: '9',
      output_bytes: '137'
    })
    expect(event?.payload).toMatchObject({
      state: 'working',
      toolName: 'bash',
      toolInput: 'pnpm test'
    })
  })

  it('does not re-open a question on post_tool, which fires after the answer', () => {
    const pending = ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_2',
      tool_name: 'request_permission',
      tool_input: '{"action":"delete the staging bucket","reason":"Why this needs approval"}'
    })
    expect(pending?.payload.state).toBe('waiting')
    expect(pending?.payload.interactivePrompt).toBeDefined()
    const event = ingest(state, {
      event: 'post_tool',
      session_id: 'session_jc_2',
      tool_name: 'request_permission',
      status: 'ok'
    })
    expect(event?.payload).toMatchObject({ state: 'working' })
    expect(event?.payload.interactivePrompt).toBeUndefined()
  })

  it('surfaces the turn error instead of a stale reply when a turn fails', () => {
    const previous = ingest(state, {
      event: 'turn_end',
      session_id: 'session_jc_3',
      status: 'ok',
      last_assistant_text: 'Stale reply.'
    })
    expect(previous?.payload.lastAssistantMessage).toBe('Stale reply.')
    const event = ingest(state, {
      event: 'turn_end',
      session_id: 'session_jc_3',
      status: 'error',
      model: 'claude-haiku-4-5',
      error: 'Anthropic API error (503 Service Unavailable)'
    })
    expect(event?.payload).toMatchObject({
      state: 'done',
      lastAssistantMessage: 'Anthropic API error (503 Service Unavailable)'
    })
  })

  it('clears the previous turn tool when a new turn starts', () => {
    const previous = ingest(state, {
      event: 'pre_tool',
      session_id: 'session_jc_4',
      tool_name: 'bash',
      tool_input: '{"command":"pnpm lint"}'
    })
    expect(previous?.payload).toMatchObject({ toolName: 'bash', toolInput: 'pnpm lint' })
    const event = ingest(state, {
      event: 'turn_start',
      session_id: 'session_jc_4',
      model: 'claude-haiku-4-5',
      source: 'chat'
    })
    expect(event?.payload?.toolName).toBeUndefined()
    expect(event?.payload?.toolInput).toBeUndefined()
  })
})
