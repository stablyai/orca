import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { clearGrokSessionPathLookupCacheForTests } from './grok-session-paths'
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

  // #31311: a resumed Kimi pane must report its session before any prompt, or quit captures nothing.
  it('lands a resumed Kimi SessionStart as an idle boundary carrying its session', () => {
    const sessionStart = (source: string) =>
      normalizeHookPayload(
        state,
        'kimi',
        {
          paneKey: PANE_KEY,
          payload: { hook_event_name: 'SessionStart', session_id: 'session_abc', source }
        },
        'production'
      )

    const resumed = sessionStart('resume')
    expect(resumed?.payload).toMatchObject({
      agentType: 'kimi',
      state: 'done',
      sessionBoundary: true
    })
    expect(resumed?.providerSession).toMatchObject({ key: 'session_id', id: 'session_abc' })
    expect(sessionStart('startup')).toBeNull()
  })

  // Kimi compact/harness events need the same sticky-working guards as Claude (#11352).
  it('ignores harness-injected UserPromptSubmit for Kimi', () => {
    normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          prompt: [{ type: 'text', text: 'list the files here' }]
        }
      },
      'production'
    )
    const harness = normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          prompt:
            'This session is being continued from a previous conversation that ran out of context.'
        }
      },
      'production'
    )
    expect(harness).toBeNull()
    const tool = normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' }
        }
      },
      'production'
    )
    expect(tool).not.toBeNull()
    expect(tool!.payload.state).toBe('working')
    expect(tool!.payload.prompt).toBe('list the files here')
    expect(tool!.payload.agentType).toBe('kimi')
  })

  // Muse 1.3.0 emits Claude-shaped hooks including Stop last_assistant_message; retain Muse attribution.
  it('normalizes Muse Claude-compatible lifecycle events as muse status', () => {
    const base = {
      session_id: '01a0caa3-0e77-7d41-bad7-46283a45633d',
      turn_id: '2c040170-d894-4268-ad7b-1b2f9bf2e2e2',
      cwd: '/tmp/ws',
      transcript_path: null,
      model: 'muse-spark-1.3',
      permission_mode: 'default',
      model_provider: 'meta'
    }
    // Keep this captured session ID away from developer Muse transcripts.
    vi.stubEnv('XDG_DATA_HOME', '/tmp/orca-muse-vendors-test-no-data')
    const bash = { command: 'ls -la' }
    const submitted = normalizeAndAccept(state, 'muse', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'say hi again'
    })
    normalizeAndAccept(state, 'muse', {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'bash',
      tool_input: bash,
      tool_use_id: 'call_1'
    })
    // Why: auto-approved tools also emit PermissionRequest, so only Notification means a prompt.
    const permissionRequest = normalizeAndAccept(state, 'muse', {
      ...base,
      hook_event_name: 'PermissionRequest',
      tool_name: 'bash',
      tool_input: bash
    })
    const waiting = normalizeAndAccept(state, 'muse', {
      ...base,
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      title: 'ws — waiting for approval',
      message: 'bash wants to run'
    })
    const approved = normalizeAndAccept(state, 'muse', {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'bash',
      tool_input: bash,
      tool_use_id: 'call_1'
    })
    const stopped = normalizeAndAccept(state, 'muse', {
      ...base,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'echo: say hi again'
    })

    expect(submitted?.payload).toMatchObject({
      agentType: 'muse',
      state: 'working',
      prompt: 'say hi again'
    })
    expect(permissionRequest).toBeNull()
    expect(waiting?.payload).toMatchObject({
      agentType: 'muse',
      state: 'waiting',
      toolName: 'bash',
      interactivePrompt: JSON.stringify({ approval: { tool: 'bash', summary: 'ls -la' } })
    })
    expect(approved?.payload.state).toBe('working')
    expect(approved?.payload.interactivePrompt).toBeUndefined()
    expect(stopped?.payload).toMatchObject({
      agentType: 'muse',
      state: 'done',
      lastAssistantMessage: 'echo: say hi again'
    })
    // The Claude-shaped session_id is captured for provider-session resume.
    expect(stopped?.providerSession).toMatchObject({
      key: 'session_id',
      id: '01a0caa3-0e77-7d41-bad7-46283a45633d'
    })
  })

  it.each(['AskUserQuestion', 'request_user_input'])(
    'keeps Muse %s pending until answered',
    (toolName) => {
      const toolInput = { questions: [{ question: 'Which color?', options: [{ label: 'Blue' }] }] }
      const pending = normalizeAndAccept(state, 'muse', {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput
      })
      expect(pending?.payload).toMatchObject({
        agentType: 'muse',
        state: 'waiting',
        interactivePrompt: JSON.stringify(toolInput)
      })
      const answered = normalizeAndAccept(state, 'muse', {
        hook_event_name: 'PostToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: 'Blue'
      })
      expect(answered?.payload.state).toBe('working')
      expect(answered?.payload.interactivePrompt).toBeUndefined()
    }
  )
})
