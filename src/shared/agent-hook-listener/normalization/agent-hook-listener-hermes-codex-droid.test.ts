import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { clearGrokSessionPathLookupCacheForTests } from '../../grok-session-paths'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    clearGrokSessionPathLookupCacheForTests()
    vi.unstubAllEnvs()
  })

  it('clears stale Codex tool input when a same-tool update has explicit unpreviewable input', () => {
    normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'BespokeTool',
          tool_input: 'old preview'
        }
      },
      'production'
    )

    const next = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'BespokeTool',
          tool_input: { request_id: 'approval-1' }
        }
      },
      'production'
    )

    expect(next?.payload.toolName).toBe('BespokeTool')
    expect(next?.payload.toolInput).toBeUndefined()
  })

  it('maps Codex request_user_input PreToolUse to waiting with the question card, then clears on the answer', () => {
    // Real Codex 0.145 shapes: PreToolUse fires while blocked on the answer (no Stop),
    // PostToolUse carries the answers, Stop ends the turn.
    const questions = {
      questions: [
        {
          id: 'color_preference',
          header: 'Color',
          question: 'Which color do you prefer: red or blue?',
          options: [{ label: 'Blue', description: 'Choose blue.' }]
        }
      ]
    }
    const waiting = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'request_user_input',
          tool_input: questions,
          tool_use_id: 'call_1'
        }
      },
      'production'
    )
    expect(waiting?.payload.state).toBe('waiting')
    expect(waiting?.payload.toolName).toBe('request_user_input')
    expect(waiting?.payload.interactivePrompt).toBe(JSON.stringify(questions))

    const answered = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          tool_name: 'request_user_input',
          tool_input: questions,
          tool_response: '{"answers":{"color_preference":{"answers":["Blue"]}}}',
          tool_use_id: 'call_1'
        }
      },
      'production'
    )
    expect(answered?.payload.state).toBe('working')
    expect(answered?.payload.interactivePrompt).toBeUndefined()

    const stop = normalizeHookPayload(
      state,
      'codex',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'Stop' } },
      'production'
    )
    expect(stop?.payload.state).toBe('done')
  })

  it('records the new folder when Codex forks a thread elsewhere (/cd, /worktree)', () => {
    normalizeAndAccept(state, 'codex', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'thread-a',
      prompt: 'go',
      cwd: '/repo/a'
    })
    const forked = normalizeAndAccept(state, 'codex', {
      hook_event_name: 'SessionStart',
      session_id: 'thread-b',
      source: 'startup',
      cwd: '/repo/b'
    })

    expect(forked?.providerSession).toMatchObject({ id: 'thread-b', cwd: '/repo/b' })
  })

  it('clears stale Droid tool input when a same-tool update has explicit unpreviewable input', () => {
    normalizeHookPayload(
      state,
      'droid',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'BespokeTool',
          tool_input: 'old preview'
        }
      },
      'production'
    )

    const next = normalizeHookPayload(
      state,
      'droid',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'BespokeTool',
          tool_input: { request_id: 'approval-1' }
        }
      },
      'production'
    )

    expect(next?.payload.toolName).toBe('BespokeTool')
    expect(next?.payload.toolInput).toBeUndefined()
  })

  // Order captured from a real Hermes `delegate_task` run (session ids shortened).
  it("keeps the Hermes pane's provider session on the parent, never a delegate child", () => {
    const parent = { session_id: 'local-parent' }
    const child = { session_id: '20261024_child' }
    const sessions = (
      [
        ['on_session_start', { ...parent, platform: 'cli' }],
        ['pre_llm_call', { ...parent, platform: 'cli', user_message: 'delegate it' }],
        ['pre_tool_call', { ...parent, tool_name: 'delegate_task' }],
        ['on_session_start', { ...child, platform: 'subagent' }],
        ['pre_llm_call', { ...child, platform: 'subagent' }],
        ['pre_tool_call', { ...child, tool_name: 'read_file' }],
        ['post_llm_call', { ...child, platform: 'subagent' }],
        ['on_session_end', child],
        ['post_tool_call', { ...parent, tool_name: 'delegate_task' }],
        ['on_session_end', parent]
      ] as const
    ).map(
      ([hook_event_name, payload]) =>
        normalizeHookPayload(
          state,
          'hermes',
          { paneKey: PANE_KEY, payload: { hook_event_name, ...payload } },
          'production'
        )?.providerSession?.id ?? null
    )
    expect(sessions).toEqual(['local-parent', 'local-parent', ...Array(8).fill(null)])
  })
})
