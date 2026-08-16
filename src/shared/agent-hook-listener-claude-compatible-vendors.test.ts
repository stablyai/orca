import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHookListenerState,
  normalizeHookPayload,
  type HookListenerState
} from './agent-hook-listener'
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

    expect(message?.payload).toMatchObject({
      agentType: 'mimo-code',
      state: 'working',
      prompt: 'ship the fix'
    })
    expect(message?.promptInteractionKey).toBe('mimo-code-message-message-1')
    expect(message?.providerSession).toMatchObject({ key: 'session_id', id: 'mimo-session' })
    expect(tool?.payload).toMatchObject({ agentType: 'mimo-code', state: 'working' })
    expect(idle?.payload).toMatchObject({ agentType: 'mimo-code', state: 'done' })
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
})
