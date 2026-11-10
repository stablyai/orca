import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './normalize-hook-payload'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  movePaneCacheState
} from '../listener-state'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'

const PANE = makePaneKey('claude-model', '11111111-1111-4111-8111-111111111111')
const MOVED = makePaneKey('claude-model', '22222222-2222-4222-8222-222222222222')

function fixture() {
  const state = createHookListenerState()
  const captured: { payload: Record<string, unknown> } = JSON.parse(
    readFileSync(
      new URL('../../__fixtures__/claude-cancel-subagent-hooks.jsonl', import.meta.url),
      'utf8'
    ).split('\n')[0]
  )
  const send = (payload: Record<string, unknown>, paneKey = PANE) =>
    normalizeHookPayload(
      state,
      'claude',
      { paneKey, payload: { session_id: captured.payload.session_id, ...payload } },
      'production'
    )?.payload
  return { state, send, start: captured.payload }
}

describe('Claude session model reports', () => {
  it('retains the recorded startup model across lead turns and child waits', () => {
    const { send, start } = fixture()
    expect(send(start)?.model).toBe('claude-fable-5-1[1m]')
    for (const payload of [
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      { hook_event_name: 'SubagentStart', agent_id: 'child' },
      { hook_event_name: 'PermissionRequest', agent_id: 'child', model: 'child-model' },
      { hook_event_name: 'PostToolUse', agent_id: 'child', tool_name: 'Bash' },
      { hook_event_name: 'Stop' },
      { hook_event_name: 'SubagentStop', agent_id: 'child' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'next' }
    ]) {
      expect(send(payload)?.model).toBe('claude-fable-5-1[1m]')
    }
  })

  it('accepts same-session resume reports while ignoring child, compact and unknown starts', () => {
    const { send, start } = fixture()
    send(start)
    for (const payload of [
      { hook_event_name: 'SessionStart', source: 'compact', model: 'compact-model' },
      { hook_event_name: 'SessionStart', source: 'unknown', model: 'unknown-model' },
      { hook_event_name: 'SessionStart', source: 'startup', agent_id: 'child', model: 'child' }
    ]) {
      expect(send(payload)).toBeUndefined()
      expect(send({ hook_event_name: 'Stop' })?.model).toBe('claude-fable-5-1[1m]')
    }
    expect(
      send({ hook_event_name: 'SessionStart', source: 'resume', model: 'sonnet' })?.model
    ).toBe('sonnet')
    expect(send({ hook_event_name: 'SessionStart', source: 'resume' })?.model).toBe('sonnet')
  })

  it('does not copy the old model into a replacement session with no start report', () => {
    const { send, start } = fixture()
    send(start)
    expect(
      send({ hook_event_name: 'UserPromptSubmit', session_id: 'replacement', prompt: 'go' })?.model
    ).toBeUndefined()
    expect(
      send({
        hook_event_name: 'SessionStart',
        session_id: 'replacement',
        source: 'clear',
        model: 'opus'
      })?.model
    ).toBe('opus')
  })

  it('moves the session report with its pane and retires it on pane or listener teardown', () => {
    const { state, send, start } = fixture()
    send(start)
    movePaneCacheState(state, PANE, MOVED)
    expect(send({ hook_event_name: 'Stop' }, MOVED)?.model).toBe('claude-fable-5-1[1m]')
    expect(send({ hook_event_name: 'Stop' })?.model).toBeUndefined()
    clearPaneCacheState(state, MOVED)
    expect(send({ hook_event_name: 'Stop' }, MOVED)?.model).toBeUndefined()
    send(start)
    clearAllListenerCaches(state)
    expect(send({ hook_event_name: 'Stop' })?.model).toBeUndefined()
  })
})
