import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { clearGrokSessionPathLookupCacheForTests } from '../../grok-session-paths'
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

    // Answered questions must release attention/notification state at tool_execution_end.
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
    // Later tools must not inherit the previous question's blocked state or card.
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

  it('blocks an OMP pane on a tool approval request and clears it on resolution', () => {
    const requested = normalizeHookPayload(
      state,
      'omp',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'tool_approval_requested',
          tool_name: 'bash',
          reason: 'Critical pattern detected',
          approval_mode: 'always-ask'
        }
      },
      'production'
    )

    expect(requested?.payload).toMatchObject({
      state: 'blocked',
      agentType: 'omp',
      toolName: 'bash',
      toolInput: 'Critical pattern detected'
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
})
