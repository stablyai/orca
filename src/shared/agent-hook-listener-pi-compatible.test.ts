import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { clearGrokSessionPathLookupCacheForTests } from './grok-session-paths'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    clearGrokSessionPathLookupCacheForTests()
    vi.unstubAllEnvs()
  })

  it('maps Pi tool_call ask_user_question to blocked with interactivePrompt', () => {
    const questions = {
      questions: [
        {
          question: 'What is your priority?',
          options: ['A', 'B', 'C']
        }
      ]
    }
    const blocked = normalizeHookPayload(
      state,
      'pi',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: {
          hook_event_name: 'tool_call',
          tool_name: 'ask_user_question',
          tool_input: questions
        }
      },
      'production'
    )
    expect(blocked?.payload).toMatchObject({
      state: 'blocked',
      agentType: 'pi',
      toolName: 'ask_user_question'
    })
    expect(blocked?.payload.interactivePrompt).toBe(JSON.stringify(questions))
  })

  it('maps Pi tool_execution_start ask_user_question to blocked with interactivePrompt', () => {
    const questions = {
      questions: [
        {
          question: 'Pick a path',
          options: ['path-1', 'path-2']
        }
      ]
    }
    const blocked = normalizeHookPayload(
      state,
      'pi',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: {
          hook_event_name: 'tool_execution_start',
          tool_name: 'ask_user_question',
          tool_input: questions
        }
      },
      'production'
    )
    expect(blocked?.payload).toMatchObject({
      state: 'blocked',
      agentType: 'pi',
      toolName: 'ask_user_question'
    })
    expect(blocked?.payload.interactivePrompt).toBe(JSON.stringify(questions))
  })

  it('keeps Pi regular tool_call notifications as working', () => {
    const working = normalizeHookPayload(
      state,
      'pi',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: {
          hook_event_name: 'tool_call',
          tool_name: 'bash',
          tool_input: { command: 'git status' }
        }
      },
      'production'
    )
    expect(working?.payload).toMatchObject({
      state: 'working',
      agentType: 'pi',
      toolName: 'bash',
      toolInput: 'git status'
    })
    expect(working?.payload.interactivePrompt).toBeUndefined()
  })

  it('keeps Pi ask_user_question blocked when tool_input is missing', () => {
    const blocked = normalizeHookPayload(
      state,
      'pi',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: {
          hook_event_name: 'tool_call',
          tool_name: 'ask_user_question'
        }
      },
      'production'
    )
    expect(blocked?.payload).toMatchObject({
      state: 'blocked',
      agentType: 'pi',
      toolName: 'ask_user_question'
    })
    expect(blocked?.payload.interactivePrompt).toBeUndefined()
  })

  it('clears Pi ask_user_question blocked once the tool_execution_end arrives', () => {
    const questions = {
      questions: [{ question: 'Ship it?', options: ['yes', 'no'] }]
    }
    const base = {
      paneKey: PANE_KEY,
      tabId: 'tab-1',
      worktreeId: 'wt',
      env: 'production' as const,
      version: '1'
    }
    const blocked = normalizeHookPayload(
      state,
      'pi',
      {
        ...base,
        payload: {
          hook_event_name: 'tool_call',
          tool_name: 'ask_user_question',
          tool_input: questions
        }
      },
      'production'
    )
    expect(blocked?.payload.state).toBe('blocked')
    expect(blocked?.payload.interactivePrompt).toBe(JSON.stringify(questions))

    // Why: the answered question must leave the blocked/needs-attention state so
    // the notification and attention sort clear; tool_execution_end is working.
    const cleared = normalizeHookPayload(
      state,
      'pi',
      {
        ...base,
        payload: {
          hook_event_name: 'tool_execution_end',
          tool_name: 'ask_user_question'
        }
      },
      'production'
    )
    expect(cleared?.payload.state).toBe('working')
    expect(cleared?.payload.interactivePrompt).toBeUndefined()
  })

  it('marks Pi done when agent_end follows an ask_user_question block', () => {
    const base = {
      paneKey: PANE_KEY,
      tabId: 'tab-1',
      worktreeId: 'wt',
      env: 'production' as const,
      version: '1'
    }
    normalizeHookPayload(
      state,
      'pi',
      {
        ...base,
        payload: {
          hook_event_name: 'tool_call',
          tool_name: 'ask_user_question',
          tool_input: { questions: [{ question: 'Pick', options: ['a', 'b'] }] }
        }
      },
      'production'
    )
    const done = normalizeHookPayload(
      state,
      'pi',
      { ...base, payload: { hook_event_name: 'agent_end' } },
      'production'
    )
    expect(done?.payload.state).toBe('done')
    expect(done?.payload.interactivePrompt).toBeUndefined()
  })

  it('clears the ask_user_question interactivePrompt when a regular Pi tool runs next', () => {
    const base = {
      paneKey: PANE_KEY,
      tabId: 'tab-1',
      worktreeId: 'wt',
      env: 'production' as const,
      version: '1'
    }
    normalizeHookPayload(
      state,
      'pi',
      {
        ...base,
        payload: {
          hook_event_name: 'tool_call',
          tool_name: 'ask_user_question',
          tool_input: { questions: [{ question: 'Pick', options: ['a', 'b'] }] }
        }
      },
      'production'
    )
    // Why: a follow-up regular tool must not inherit the prior question's blocked
    // state or its live interactivePrompt card.
    const working = normalizeHookPayload(
      state,
      'pi',
      {
        ...base,
        payload: {
          hook_event_name: 'tool_call',
          tool_name: 'bash',
          tool_input: { command: 'ls' }
        }
      },
      'production'
    )
    expect(working?.payload).toMatchObject({
      state: 'working',
      agentType: 'pi',
      toolName: 'bash',
      toolInput: 'ls'
    })
    expect(working?.payload.interactivePrompt).toBeUndefined()
  })

  it('normalizes OMP Pi-compatible hooks with OMP attribution', () => {
    const event = normalizeHookPayload(
      state,
      'omp',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: {
          hook_event_name: 'before_agent_start',
          prompt: 'wire omp status'
        }
      },
      'production'
    )
    expect(event?.payload).toMatchObject({
      state: 'working',
      prompt: 'wire omp status',
      agentType: 'omp'
    })

    const tool = normalizeHookPayload(
      state,
      'omp',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: {
          hook_event_name: 'tool_call',
          tool_name: 'bash',
          tool_input: { command: 'pnpm test' }
        }
      },
      'production'
    )
    expect(tool?.payload).toMatchObject({
      state: 'working',
      prompt: 'wire omp status',
      agentType: 'omp',
      toolName: 'bash',
      toolInput: 'pnpm test'
    })
    expect(tool?.payload.interactivePrompt).toBeUndefined()
  })

  it('maps OMP ask to blocked and publishes its questions payload', () => {
    const questions = {
      questions: [
        {
          question: 'Choose',
          options: [
            { label: 'x', description: 'First' },
            { label: 'y', description: 'Second' }
          ]
        }
      ]
    }
    const tool = normalizeHookPayload(
      state,
      'omp',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: {
          hook_event_name: 'tool_execution_start',
          tool_name: 'ask',
          tool_input: questions
        }
      },
      'production'
    )
    expect(tool?.payload).toMatchObject({
      state: 'blocked',
      agentType: 'omp',
      toolName: 'ask'
    })
    expect(tool?.payload.interactivePrompt).toBe(JSON.stringify(questions))
  })

  it('blocks an OMP pane on a tool approval request and clears it on resolution', () => {
    const requested = normalizeHookPayload(
      state,
      'omp',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'tool_approval_requested',
          tool_name: 'bash',
          reason: 'tools.approval.bash: prompt',
          approval_mode: 'prompt'
        }
      },
      'production'
    )

    expect(requested?.payload).toMatchObject({
      state: 'blocked',
      agentType: 'omp',
      toolName: 'bash',
      toolInput: 'tools.approval.bash: prompt'
    })

    const resolved = normalizeHookPayload(
      state,
      'omp',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'tool_approval_resolved', tool_name: 'bash', approved: true }
      },
      'production'
    )

    expect(resolved?.payload).toMatchObject({ state: 'working', toolName: 'bash' })
    expect(resolved?.payload.toolInput).toBeUndefined()
  })

  it.each(['tool_approval_requested', 'tool_approval_resolved'])(
    'ignores %s from Pi-compatible agents that do not emit it',
    (hookEventName) => {
      expect(
        normalizeHookPayload(
          state,
          'pi',
          { paneKey: PANE_KEY, payload: { hook_event_name: hookEventName, tool_name: 'bash' } },
          'production'
        )
      ).toBeNull()
    }
  )

  it('captures Pi session ids on Pi-compatible status events', () => {
    const event = normalizeHookPayload(
      state,
      'pi',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'before_agent_start',
          prompt: 'resume this task',
          session_id: 'pi-session-1',
          session_file: '/tmp/pi-session-1.jsonl'
        }
      },
      'production'
    )

    expect(event?.payload).toMatchObject({
      state: 'working',
      prompt: 'resume this task',
      agentType: 'pi'
    })
    expect(event?.providerSession).toEqual({
      key: 'session_id',
      id: 'pi-session-1',
      transcriptPath: '/tmp/pi-session-1.jsonl'
    })
  })

  it('clears Pi turn cache and emits only resume identity on session_start', () => {
    const start = normalizeHookPayload(
      state,
      'pi',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'before_agent_start', prompt: 'stale turn' }
      },
      'production'
    )
    expect(start?.payload.prompt).toBe('stale turn')

    const sessionStart = normalizeHookPayload(
      state,
      'pi',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'session_start',
          session_id: 'pi-session-2',
          session_file: '/tmp/pi-session-2.jsonl'
        }
      },
      'production'
    )
    expect(sessionStart).toMatchObject({
      providerSessionOnly: true,
      providerSession: {
        key: 'session_id',
        id: 'pi-session-2',
        transcriptPath: '/tmp/pi-session-2.jsonl'
      },
      payload: { state: 'done', prompt: '', agentType: 'pi' }
    })

    const next = normalizeHookPayload(
      state,
      'pi',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'tool_call', tool_name: 'bash' } },
      'production'
    )
    expect(next?.payload.prompt).toBe('')
  })

  it('normalizes Prime status and session identity without Pi-only ask-user behavior', () => {
    const tool = normalizeHookPayload(
      state,
      'prime-agent',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'tool_call',
          prompt: 'prime task',
          tool_name: 'ask_user_question',
          tool_input: { questions: [{ question: 'Choose', options: ['x'] }] },
          session_id: 'prime-session-1',
          session_file: '/tmp/prime-session-1.jsonl'
        }
      },
      'production'
    )
    expect(tool).toMatchObject({
      source: 'prime-agent',
      providerSession: {
        key: 'session_id',
        id: 'prime-session-1',
        transcriptPath: '/tmp/prime-session-1.jsonl'
      },
      payload: { state: 'working', agentType: 'prime-agent', prompt: 'prime task' }
    })
    expect(tool?.payload.interactivePrompt).toBeUndefined()

    const sessionStart = normalizeHookPayload(
      state,
      'prime-agent',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'session_start',
          session_id: 'prime-session-2',
          session_file: '/tmp/prime-session-2.jsonl'
        }
      },
      'production'
    )
    expect(sessionStart).toMatchObject({
      providerSessionOnly: true,
      payload: { state: 'done', prompt: '', agentType: 'prime-agent' }
    })
  })
})
