import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { clearGrokSessionPathLookupCacheForTests } from './grok-session-paths'
import {
  CLAUDE_PREVIOUS_PROMPT_ID,
  CLAUDE_PROMPT_ID,
  normalizeAndAccept,
  PANE_KEY
} from './agent-hook-listener-test-harness'

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    clearGrokSessionPathLookupCacheForTests()
    vi.unstubAllEnvs()
  })

  it('normalizes a Claude-compatible StopFailure to done without copying provider error text', () => {
    normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'say hi' }
      },
      'production'
    )

    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'StopFailure',
          error: 'invalid_request',
          error_details: 'model is not supported',
          last_assistant_message: 'API Error: model is not supported'
        }
      },
      'production'
    )

    expect(event?.payload).toMatchObject({
      state: 'done',
      prompt: 'say hi',
      agentType: 'claude'
    })
    expect(event?.payload.lastAssistantMessage).toBeUndefined()
  })

  it('maps Claude SessionStart to an idle done row so a resumed session earns its sidebar row before the first prompt', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'SessionStart',
          source: 'resume',
          session_id: '44444444-4444-4444-8444-444444444444'
        }
      },
      'production'
    )

    // Why: 'working' would show a phantom spinner on an idle TUI; a session-boundary
    // 'done' renders the row idle, which is the truth at SessionStart.
    expect(event?.payload).toMatchObject({
      state: 'done',
      prompt: '',
      agentType: 'claude',
      sessionBoundary: true
    })
    expect(event?.payload.interrupted).toBeUndefined()
    expect(event?.hookEventName).toBe('SessionStart')
    // Why: SessionStart carries resume identity, so in-app resume works before any prompt.
    expect(event?.providerSession).toMatchObject({
      key: 'session_id',
      id: '44444444-4444-4444-8444-444444444444'
    })
  })

  it('resets stale Claude turn state when SessionStart announces a new session on the pane', () => {
    normalizeAndAccept(state, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'fix bug' })
    normalizeAndAccept(state, 'claude', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    normalizeAndAccept(state, 'claude', { hook_event_name: 'SubagentStart', agent_id: 'agent-1' })

    const event = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'SessionStart',
      source: 'startup'
    })

    // Why: a new process owns the pane; stale prompt/tool/children must not survive
    // into the fresh session's idle row or gate it back up to 'working'.
    expect(event?.payload.state).toBe('done')
    expect(event?.payload.prompt).toBe('')
    expect(event?.payload.toolName).toBeUndefined()
    expect(event?.payload.subagents).toBeUndefined()
  })

  it('keeps the running Claude turn when SessionStart comes from a compact restart or a child session', () => {
    normalizeAndAccept(state, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'say hi' })

    const compacted = normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'SessionStart', source: 'compact' } },
      'production'
    )
    // Why: unknown/missing sources fail closed — only startup/resume/clear are idle boundaries.
    const unknownSource = normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'SessionStart' } },
      'production'
    )
    const child = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'SessionStart', source: 'startup', agent_id: 'agent-7' }
      },
      'production'
    )
    const stopped = normalizeAndAccept(state, 'claude', { hook_event_name: 'Stop' })

    // Why: auto-compact restarts mid-turn (PreCompact/PostCompact own that lifecycle) and a
    // child-attributed SessionStart must not flip the lead's live turn to an idle row.
    expect(compacted).toBeNull()
    expect(unknownSource).toBeNull()
    expect(child).toBeNull()
    expect(stopped?.payload).toMatchObject({ state: 'done', prompt: 'say hi' })
    expect(stopped?.payload.sessionBoundary).toBeUndefined()
  })

  it('rejects oversized paneKey', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: 'x'.repeat(300),
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }
      },
      'production'
    )
    expect(event).toBeNull()
  })

  it('resumes work for task notifications without replacing the cached prompt', () => {
    normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'UserPromptSubmit', prompt: 'fix login' } },
      'production'
    )
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          prompt: '<task-notification> <task-id>bzthj2b8r</task-id> <tool-use-id>t1</tool-use-id>'
        }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.payload.state).toBe('working')
    expect(event!.payload.prompt).toBe('fix login')
    expect(event!.hasExplicitPrompt).toBe(false)
  })

  it('emits a harness-injected UserPromptSubmit with an empty uncached prompt', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          prompt: '<system-reminder>background context</system-reminder>'
        }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.payload.state).toBe('working')
    expect(event!.payload.prompt).toBe('')
    expect(event!.hasExplicitPrompt).toBe(false)
  })

  it('does not leave working after a compact-summary UserPromptSubmit (issue #11352)', () => {
    // Live repro: after /compact Claude injects "This session is being continued…" with no Stop.
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          prompt:
            'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.'
        }
      },
      'production'
    )
    expect(event).toBeNull()
  })

  it('maps a Claude manual compact lifecycle, ignoring the pre-validation event', () => {
    normalizeAndAccept(state, 'claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'work before compact',
      prompt_id: CLAUDE_PREVIOUS_PROMPT_ID,
      session_id: 'session-a'
    })
    // Why: PreCompact fires before the compact is validated — an aborted compact emits it alone —
    // so it is neither registered nor mapped. Only the completion may move the pane.
    const pre = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      prompt_id: CLAUDE_PROMPT_ID,
      session_id: 'session-a'
    })
    expect(pre).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')

    const post = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      prompt_id: CLAUDE_PROMPT_ID,
      session_id: 'session-a'
    })
    expect(post).not.toBeNull()
    expect(post!.payload.state).toBe('done')
    expect(post!.payload.agentType).toBe('claude')
    expect(post!.payload.sessionBoundary).toBe(true)
  })

  it('keeps the preceding user prompt on the completed compact row', () => {
    normalizeAndAccept(state, 'claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'work before compact',
      prompt_id: CLAUDE_PREVIOUS_PROMPT_ID,
      session_id: 'session-a'
    })
    const post = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      prompt_id: CLAUDE_PROMPT_ID,
      session_id: 'session-a'
    })
    expect(post).not.toBeNull()
    expect(post!.payload.state).toBe('done')
    expect(post!.payload.prompt).toBe('work before compact')
  })

  it('treats a custom-element paste as an explicit user turn, not machinery', () => {
    normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'UserPromptSubmit', prompt: 'fix login' } },
      'production'
    )
    // Why: a real prompt starting with an unknown kebab tag (<my-custom-element>)
    // is the user's turn — it must reset the cached prompt and count as explicit,
    // so interrupt recovery does not leave the pane visibly done.
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          prompt: '<my-custom-element> render this component'
        }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.payload.prompt).toBe('<my-custom-element> render this component')
    expect(event!.hasExplicitPrompt).toBe(true)
  })

  it('treats a Grok user_query prompt as an explicit user turn', () => {
    const event = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'user_prompt_submit',
          prompt: '<user_query>fix the bug</user_query>'
        }
      },
      'production'
    )
    expect(event).not.toBeNull()
    // Grok wraps the real typed prompt; the envelope is stripped but it stays explicit.
    expect(event!.payload.prompt).toBe('fix the bug')
    expect(event!.hasExplicitPrompt).toBe(true)
  })

  it('isolates caches between listener instances', () => {
    const a = createHookListenerState()
    const b = createHookListenerState()
    normalizeHookPayload(
      a,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'UserPromptSubmit', prompt: 'first' } },
      'production'
    )
    // The second listener has no cached prompt for this paneKey, so a tool
    // event without a fresh prompt should produce empty prompt string.
    const event = normalizeHookPayload(
      b,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/etc/hosts' }
        }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.payload.prompt).toBe('')
  })

  it('bounds Amp thread-scoped caches for a long-lived pane', () => {
    let latestPrompt = ''
    for (let i = 0; i < 40; i++) {
      const threadId = `thread-${i}`
      const started = normalizeHookPayload(
        state,
        'amp',
        {
          paneKey: PANE_KEY,
          payload: {
            hookEventName: 'agent.start',
            threadId,
            message: `prompt ${i}`
          }
        },
        'production'
      )
      expect(started?.payload.state).toBe('working')

      const ended = normalizeHookPayload(
        state,
        'amp',
        {
          paneKey: PANE_KEY,
          payload: {
            hookEventName: 'agent.end',
            threadId,
            status: 'completed'
          }
        },
        'production'
      )
      expect(ended?.payload.state).toBe('done')
      latestPrompt = ended?.payload.prompt ?? ''
    }

    const scopedPrefix = `${PANE_KEY}\0amp:`
    const promptKeys = [...state.lastPromptByPaneKey.keys()].filter((key) =>
      key.startsWith(scopedPrefix)
    )
    const toolKeys = [...state.lastToolByPaneKey.keys()].filter((key) =>
      key.startsWith(scopedPrefix)
    )
    const completedKeys = [...state.ampCompletedCacheKeys].filter((key) =>
      key.startsWith(scopedPrefix)
    )

    expect(promptKeys.length).toBeLessThanOrEqual(32)
    expect(toolKeys.length).toBeLessThanOrEqual(32)
    expect(completedKeys.length).toBeLessThanOrEqual(32)
    expect(state.lastPromptByPaneKey.has(`${scopedPrefix}thread-0`)).toBe(false)
    expect(state.lastPromptByPaneKey.get(`${scopedPrefix}thread-39`)).toBe('prompt 39')
    expect(latestPrompt).toBe('prompt 39')
  })
})
