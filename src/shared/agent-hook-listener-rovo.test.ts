import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { makePaneKey } from './stable-pane-id'

const PANE = makePaneKey('tab-rovo', '22222222-2222-4222-8222-222222222222')
const SESSION_ID = '89375fa0-d255-43e1-9da4-260484aa37ae'

// Payload shapes captured from a live `rovo` 0.x eventHooks run.
function rovoEvent(
  state: HookListenerState,
  hookEventName: string,
  attributes: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) {
  return normalizeHookPayload(
    state,
    'rovo',
    {
      paneKey: PANE,
      payload: {
        session_id: SESSION_ID,
        transcript_path: null,
        cwd: '/tmp/repo',
        timestamp: '2026-10-07T15:32:02.881043+00:00',
        hook_event_name: hookEventName,
        attributes,
        ...extra
      }
    },
    'production'
  )
}

let tempDir: string
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'orca-rovo-listener-'))
})
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('Rovo hook normalization', () => {
  it('starts a working turn with the nested user prompt as explicit prompt evidence', () => {
    const result = rovoEvent(createHookListenerState(), 'on_user_prompt', {
      user_prompt: 'rename the worktree'
    })

    expect(result?.payload).toMatchObject({
      state: 'working',
      prompt: 'rename the worktree',
      agentType: 'rovo'
    })
    expect(result?.hasExplicitPrompt).toBe(true)
    expect(result?.providerSession).toEqual({ key: 'session_id', id: SESSION_ID })
  })

  it('reports the running tool, waits on permission, and keeps the prompt across the turn', () => {
    const state = createHookListenerState()
    rovoEvent(state, 'on_user_prompt', { user_prompt: 'run it' })
    const toolCall = {
      tool_calls: [
        {
          tool_name: 'bash',
          tool_args: { command: 'python3 -c "print(4242)"', _intent: 'Run the command' },
          tool_call_id: 'toolu_1'
        }
      ]
    }

    expect(rovoEvent(state, 'on_tool_start', toolCall)?.payload).toMatchObject({
      state: 'working',
      prompt: 'run it',
      toolName: 'bash',
      toolInput: 'python3 -c "print(4242)"'
    })
    expect(rovoEvent(state, 'on_tool_permission')?.payload).toMatchObject({
      state: 'waiting',
      toolName: 'bash'
    })
    const ended = rovoEvent(state, 'on_tool_end', {
      tool_results: [{ tool_name: 'bash', tool_call_id: 'toolu_1' }]
    })
    expect(ended?.payload).toMatchObject({ state: 'working', toolName: 'bash' })
    expect(ended?.hasExplicitPrompt).toBe(false)
  })

  it('treats Rovo question tools as waiting on the user', () => {
    const result = rovoEvent(createHookListenerState(), 'on_tool_start', {
      tool_calls: [
        { tool_name: 'ask_user_questions', tool_args: { questions: [] }, tool_call_id: 'q' }
      ]
    })
    expect(result?.payload?.state).toBe('waiting')
  })

  it('finishes with the last assistant reply from the transcript', () => {
    const transcriptPath = join(tempDir, 'message_history.json')
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        message_history: [
          { kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'hi' }] },
          {
            kind: 'response',
            parts: [
              { part_kind: 'thinking', content: '' },
              { part_kind: 'text', content: 'All done.' }
            ]
          }
        ]
      })
    )
    const result = rovoEvent(
      createHookListenerState(),
      'on_complete',
      { status: 'completed' },
      { transcript_path: transcriptPath }
    )
    expect(result?.payload).toMatchObject({ state: 'done', lastAssistantMessage: 'All done.' })
    expect(result?.payload?.interrupted).toBeUndefined()
  })

  it('marks a non-completed finish as interrupted and errors as done', () => {
    expect(
      rovoEvent(createHookListenerState(), 'on_complete', { status: 'cancelled' })?.payload
    ).toMatchObject({ state: 'done', interrupted: true })
    expect(rovoEvent(createHookListenerState(), 'on_error')?.payload?.state).toBe('done')
  })

  it('binds the provider session on session start without inventing a turn', () => {
    const result = rovoEvent(createHookListenerState(), 'on_session_start')
    expect(result?.providerSessionOnly).toBe(true)
    expect(result?.providerSession).toEqual({ key: 'session_id', id: SESSION_ID })
    expect(rovoEvent(createHookListenerState(), 'on_interactive_ready')).toBeNull()
  })
})
