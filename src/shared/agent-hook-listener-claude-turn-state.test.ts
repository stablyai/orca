import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { markClaudeLeadTurnInterrupted } from './agent-hook-listener/providers/claude-roster-state'
import { clearGrokSessionPathLookupCacheForTests } from './grok-session-paths'
import {
  CLAUDE_PREVIOUS_PROMPT_ID,
  CLAUDE_PROMPT_ID,
  normalizeAndAccept,
  PANE_KEY
} from './agent-hook-listener-test-harness'
import { makePaneKey } from './stable-pane-id'

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

    // SessionStart is idle; working would invent a spinner before a turn.
    expect(event?.payload).toMatchObject({
      state: 'done',
      prompt: '',
      agentType: 'claude',
      sessionBoundary: true
    })
    expect(event?.payload.interrupted).toBeUndefined()
    expect(event?.hookEventName).toBe('SessionStart')
    // SessionStart resume identity must work before the first prompt.
    expect(event?.providerSession).toMatchObject({
      key: 'session_id',
      id: '44444444-4444-4444-8444-444444444444'
    })
  })

  it('records the folder a Claude session started in, not the one its Bash tool moved to (#16960)', () => {
    const sessionId = '55555555-5555-4555-8555-555555555555'
    normalizeAndAccept(state, 'claude', {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: 'go',
      cwd: '/repo/pkg'
    })
    // Claude's hook cwd follows `cd` inside its Bash tool.
    const afterCd = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'PostToolUse',
      session_id: sessionId,
      tool_name: 'Bash',
      cwd: '/repo/pkg/sub'
    })
    const cleared = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'SessionStart',
      source: 'clear',
      session_id: '66666666-6666-4666-8666-666666666666',
      cwd: '/repo/pkg'
    })
    const clearedPrompt = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'UserPromptSubmit',
      session_id: '66666666-6666-4666-8666-666666666666',
      prompt: 'next',
      cwd: '/repo/pkg/sub'
    })
    const resumedElsewhere = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'SessionStart',
      source: 'resume',
      session_id: '77777777-7777-4777-8777-777777777777',
      cwd: '/elsewhere'
    })

    expect(afterCd?.providerSession).toMatchObject({ id: sessionId, cwd: '/repo/pkg' })
    expect(cleared?.providerSession?.cwd).toBe('/repo/pkg')
    expect(clearedPrompt?.providerSession?.cwd).toBe('/repo/pkg')
    expect(resumedElsewhere?.providerSession?.cwd).toBe('/elsewhere')
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

    // New processes must not inherit stale prompt/tool/children or their working gates.
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
    // Only known startup/resume/clear boundaries may assert idle.
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

    // Auto-compact restarts mid-turn; neither it nor child SessionStart may idle the lead.
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
        paneKey: makePaneKey('x'.repeat(300), '11111111-1111-4111-8111-111111111111'),
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
    // PreCompact can occur alone on abort; only completed compaction changes pane state.
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
    // Unknown kebab-tag prompts are real turns and must reset cached/interrupt state.
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
    // Listener prompt caches must remain independent.
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

describe('the main agent verdict across a child-induced wait', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function claude(payload: Record<string, unknown>) {
    return normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')
      ?.payload
  }

  it('restores the cancelled verdict when a child permission pause clears', () => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    claude({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
    const cancelled = claude({ hook_event_name: 'Stop', is_interrupt: true })
    expect(cancelled?.mainAgent).toEqual({
      state: 'done',
      outcome: 'cancellation',
      stateStartedAt: expect.any(Number)
    })
    const settledAt = cancelled?.mainAgent?.stateStartedAt

    const wait = claude({
      hook_event_name: 'PermissionRequest',
      agent_id: 'a1',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' }
    })
    // The child's wait is child work: the main agent is still the cancelled turn, on its own clock.
    expect(wait).toMatchObject({
      state: 'waiting',
      mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: settledAt }
    })

    // The child's pause displaced the main agent; clearing it must give the verdict and clock back.
    const drained = claude({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
    expect(drained).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: settledAt }
    })
  })

  it('publishes the displaced main agent, not the child, while a child owns the wait', () => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    const running = claude({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
    const childWait = claude({
      hook_event_name: 'PermissionRequest',
      agent_id: 'a1',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' }
    })
    expect(childWait).toMatchObject({
      state: 'waiting',
      mainAgent: { state: 'working', stateStartedAt: running?.mainAgent?.stateStartedAt }
    })

    // A wait the main agent raised itself is its own state.
    const ownWait = claude({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist' }
    })
    expect(ownWait).toMatchObject({ state: 'waiting', mainAgent: { state: 'waiting' } })
  })

  it('clears the verdict when a new turn starts', () => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    claude({ hook_event_name: 'StopFailure', error: 'invalid_request' })
    expect(claude({ hook_event_name: 'UserPromptSubmit', prompt: 'again' })?.mainAgent).toEqual({
      state: 'working',
      stateStartedAt: expect.any(Number)
    })
  })
})

describe('the main agent verdict from an inferred interrupt', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function claude(payload: Record<string, unknown>) {
    return normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')
      ?.payload
  }

  // Claude has no cancel hook/is_interrupt Stop; inferred cancellation must ride mainAgent into the next Stop.
  it('carries the inferred cancellation into the next plain Stop', () => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    markClaudeLeadTurnInterrupted(state, PANE_KEY)
    expect(state.claudeLeadStateByPaneKey.get(PANE_KEY)).toMatchObject({
      state: 'done',
      outcome: 'cancellation'
    })
    const settledAt = state.claudeLeadStateByPaneKey.get(PANE_KEY)?.stateStartedAt

    const stop = claude({ hook_event_name: 'Stop' })
    expect(stop).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: settledAt }
    })
  })
})
