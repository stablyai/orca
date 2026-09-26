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

  it('normalizes Devin documented lifecycle events', () => {
    const started = normalizeHookPayload(
      state,
      'devin',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'SessionStart', source: 'resume' }
      },
      'production'
    )
    const compacted = normalizeHookPayload(
      state,
      'devin',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'PostCompaction', summary: 'trimmed' }
      },
      'production'
    )
    const ended = normalizeHookPayload(
      state,
      'devin',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'SessionEnd', reason: 'complete' }
      },
      'production'
    )

    // Why: SessionStart fires when the TUI opens/resumes while still idle.
    // It must not create a visible "working" row before the user submits a prompt.
    expect(started).toBeNull()
    expect(compacted?.payload).toMatchObject({ agentType: 'devin', state: 'working' })
    expect(ended?.payload).toMatchObject({ agentType: 'devin', state: 'done' })
  })

  it('normalizes Kimi Code Claude-compatible lifecycle events as kimi status', () => {
    const submitted = normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'session_abc',
          cwd: '/repo',
          // Kimi sends the prompt as a content-block array, not a bare string.
          prompt: [{ type: 'text', text: 'list the files here' }]
        }
      },
      'production'
    )
    const tool = normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          session_id: 'session_abc',
          tool_name: 'Bash',
          tool_input: { command: 'ls' }
        }
      },
      'production'
    )
    const waiting = normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'PermissionRequest', session_id: 'session_abc' }
      },
      'production'
    )
    const stopped = normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'Stop', session_id: 'session_abc' }
      },
      'production'
    )

    expect(submitted?.payload).toMatchObject({
      agentType: 'kimi',
      state: 'working',
      prompt: 'list the files here'
    })
    expect(tool?.payload).toMatchObject({ agentType: 'kimi', state: 'working', toolName: 'Bash' })
    expect(waiting?.payload).toMatchObject({ agentType: 'kimi', state: 'waiting' })
    expect(stopped?.payload).toMatchObject({ agentType: 'kimi', state: 'done' })
    // The Claude-shaped session_id is captured for provider-session resume.
    expect(stopped?.providerSession).toMatchObject({ key: 'session_id', id: 'session_abc' })
  })

  // Why: Kimi shares Claude-compatible compact/harness hooks; cover the same sticky-working
  // guards so a Kimi-only regression cannot slip past the Claude-only tests (issue #11352).
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

  // Why: a Kimi UserPromptSubmit hook re-emits its own <hook_result> envelope as a
  // prompt; letting it win makes branch auto-naming anchor on the envelope (#14789).
  it('keeps the typed prompt when a Kimi hook_result envelope follows', () => {
    const typed = normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'debug the CI config' }
      },
      'production'
    )
    expect(typed?.payload.prompt).toBe('debug the CI config')

    const envelope = normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          prompt: '<hook_result hook_event="UserPromptSubmit">{}</hook_result>'
        }
      },
      'production'
    )
    expect(envelope?.payload.prompt).toBe('debug the CI config')
  })

  it('ignores unproven Kimi compact lifecycle events', () => {
    const pre = normalizeAndAccept(state, 'kimi', {
      hook_event_name: 'PreCompact',
      trigger: 'manual'
    })
    const post = normalizeAndAccept(state, 'kimi', {
      hook_event_name: 'PostCompact',
      trigger: 'manual'
    })

    expect(pre).toBeNull()
    expect(post).toBeNull()
    expect(state.lastStatusByPaneKey.has(PANE_KEY)).toBe(false)
  })

  it('normalizes MiMo Code OpenCode-compatible lifecycle events as mimo-code status', () => {
    const message = normalizeHookPayload(
      state,
      'mimo-code',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'MessagePart',
          sessionID: 'mimo-session',
          messageID: 'message-1',
          role: 'user',
          text: 'ship the fix'
        }
      },
      'production'
    )
    const tool = normalizeHookPayload(
      state,
      'mimo-code',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'SessionBusy',
          sessionID: 'mimo-session'
        }
      },
      'production'
    )
    const idle = normalizeHookPayload(
      state,
      'mimo-code',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'SessionIdle', sessionID: 'mimo-session' }
      },
      'production'
    )
    const sessionStart = normalizeHookPayload(
      state,
      'mimo-code',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'SessionStart', sessionID: 'mimo-session' }
      },
      'production'
    )

    expect(message?.payload).toMatchObject({
      agentType: 'mimo-code',
      state: 'working',
      prompt: 'ship the fix'
    })
    expect(message?.promptInteractionKey).toBe('mimo-code-message-message-1')
    expect(message?.providerSession).toMatchObject({ key: 'session_id', id: 'mimo-session' })
    expect(tool?.payload).toMatchObject({ agentType: 'mimo-code', state: 'working' })
    expect(idle?.payload).toMatchObject({ agentType: 'mimo-code', state: 'done' })
    expect(sessionStart).toBeNull()
  })

  it('maps Kimi AskUserQuestion PreToolUse to waiting, then back to working on answer', () => {
    const question = normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          session_id: 'session_abc',
          tool_name: 'AskUserQuestion',
          tool_input: {
            questions: [
              {
                question: 'Which region should I deploy to?',
                options: [{ label: 'us-east', description: 'US East' }]
              }
            ]
          }
        }
      },
      'production'
    )
    const answered = normalizeHookPayload(
      state,
      'kimi',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          session_id: 'session_abc',
          tool_name: 'AskUserQuestion',
          tool_response: { selected: ['us-east'] }
        }
      },
      'production'
    )

    expect(question?.payload).toMatchObject({
      agentType: 'kimi',
      state: 'waiting',
      toolName: 'AskUserQuestion'
    })
    expect(answered?.payload).toMatchObject({
      agentType: 'kimi',
      state: 'working',
      toolName: 'AskUserQuestion'
    })
  })

  // Why: Muse emits Claude-compatible hook payloads (captured from muse 1.3.0 hook stdin);
  // normalize but attribute to Muse, including the Stop `last_assistant_message`.
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
    // Why: this id is a real capture; keep the lookup off the developer's own Muse sessions.
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
