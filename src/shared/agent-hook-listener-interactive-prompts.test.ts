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

  it('normalizes a Claude UserPromptSubmit body to a working state', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.paneKey).toBe(PANE_KEY)
    expect(event!.connectionId).toBeNull()
    expect(event!.payload.state).toBe('working')
    expect(event!.payload.prompt).toBe('hello')
    expect(event!.payload.agentType).toBe('claude')
  })

  it('normalizes a BOM-prefixed Cursor hook payload to a working state', () => {
    const event = normalizeHookPayload(
      state,
      'cursor',
      {
        paneKey: PANE_KEY,
        payload: '\uFEFF{"hook_event_name":"beforeSubmitPrompt","prompt":"Synthetic Cursor prompt"}'
      },
      'production'
    )

    expect(event?.payload).toMatchObject({
      agentType: 'cursor',
      state: 'working',
      prompt: 'Synthetic Cursor prompt'
    })
    expect(event?.hookEventName).toBe('beforeSubmitPrompt')
  })

  // Why: pins the allowance to exactly one leading U+FEFF, so nobody widens it into a trim.
  it('still rejects a hook payload that is malformed once the BOM is removed', () => {
    const bom = '\uFEFF'
    const body = '{"hook_event_name":"beforeSubmitPrompt"}'
    for (const payload of [
      `${bom}${bom}${body}`,
      `${bom}not json`,
      ` ${bom}${body}`,
      `{"hook_event_name"${bom}:"beforeSubmitPrompt"}`
    ]) {
      const event = normalizeHookPayload(
        state,
        'cursor',
        { paneKey: PANE_KEY, payload },
        'production'
      )
      expect(event).toBeNull()
    }
  })

  it('normalizes Gemini BeforeTool to working with tool fields', () => {
    const event = normalizeHookPayload(
      state,
      'gemini',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'BeforeTool',
          tool_name: 'read_file',
          args: { file_path: 'src/index.ts' }
        }
      },
      'production'
    )

    expect(event?.payload.state).toBe('working')
    expect(event?.payload.agentType).toBe('gemini')
    expect(event?.payload.toolName).toBe('read_file')
    expect(event?.payload.toolInput).toBe('src/index.ts')
  })

  it('captures the full AskUserQuestion tool input as interactivePrompt (untruncated)', () => {
    const questions = {
      questions: Array.from({ length: 4 }, (_, i) => ({
        question: `Question ${i} ${'detail '.repeat(40)}`,
        options: ['option one', 'option two', 'option three']
      }))
    }
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: questions
        }
      },
      'production'
    )

    expect(event?.payload.toolName).toBe('AskUserQuestion')
    // Why: the auto-allowed AskUserQuestion PreToolUse is a human-input boundary,
    // so it must read as waiting (amber attention) rather than a working spinner.
    expect(event?.payload.state).toBe('waiting')
    const expected = JSON.stringify(questions)
    expect(event?.payload.interactivePrompt).toBe(expected)
    // Why: must NOT be truncated to the 160-char toolInput preview cap.
    expect(expected.length).toBeGreaterThan(200)
    expect(event?.payload.interactivePrompt!.length).toBe(expected.length)
  })

  it('maps Claude AskUserQuestion PreToolUse to waiting, then back to working on answer', () => {
    const question = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'Pick', options: ['a', 'b'] }] }
        }
      },
      'production'
    )
    const answered = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          tool_name: 'AskUserQuestion',
          tool_response: { selected: ['a'] }
        }
      },
      'production'
    )

    expect(question?.payload).toMatchObject({
      agentType: 'claude',
      state: 'waiting',
      toolName: 'AskUserQuestion'
    })
    expect(answered?.payload).toMatchObject({
      agentType: 'claude',
      state: 'working',
      toolName: 'AskUserQuestion'
    })
  })

  it('keeps a normal Claude PreToolUse tool call as working', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
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
    expect(event?.payload.state).toBe('working')
    expect(event?.payload.toolName).toBe('Bash')
  })

  it('leaves interactivePrompt undefined for a normal tool call', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: '/tmp/x.ts' }
        }
      },
      'production'
    )
    expect(event?.payload.toolName).toBe('Edit')
    expect(event?.payload.interactivePrompt).toBeUndefined()
  })

  it('captures an approval envelope as interactivePrompt on a PermissionRequest', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf build' }
        }
      },
      'production'
    )
    expect(event?.payload.interactivePrompt).toBe(
      JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } })
    )
  })

  it('captures an approval envelope for a Codex PermissionRequest', () => {
    const event = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'shell',
          input: { command: 'git push --force' }
        }
      },
      'production'
    )
    expect(event?.payload.interactivePrompt).toBe(
      JSON.stringify({ approval: { tool: 'shell', summary: 'git push --force' } })
    )
  })

  it('clears interactivePrompt on the next tool event after AskUserQuestion', () => {
    normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'Pick', options: ['a'] }] }
        }
      },
      'production'
    )
    const next = normalizeHookPayload(
      state,
      'claude',
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
    expect(next?.payload.toolName).toBe('Bash')
    expect(next?.payload.toolInput).toBe('ls')
    expect(next?.payload.interactivePrompt).toBeUndefined()
  })

  it('keeps AskUserQuestion visible through a late parallel sibling completion', () => {
    const questions = { questions: [{ question: 'Pick', options: ['a', 'b'] }] }
    const question = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'tool-question',
          tool_input: questions
        }
      },
      'production'
    )
    normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'AskUserQuestion',
          tool_input: questions
        }
      },
      'production'
    )
    const siblingCompletion = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_use_id: 'tool-sibling',
          tool_input: { command: 'sleep 5' }
        }
      },
      'production'
    )

    expect(siblingCompletion?.payload).toMatchObject({
      state: 'waiting',
      toolName: 'AskUserQuestion',
      interactivePrompt: question?.payload.interactivePrompt
    })
  })

  it('clears AskUserQuestion when its own PostToolUse arrives', () => {
    normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'tool-question',
          tool_input: { questions: [{ question: 'Pick', options: ['a', 'b'] }] }
        }
      },
      'production'
    )
    const answered = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'tool-question'
        }
      },
      'production'
    )

    expect(answered?.payload.state).toBe('working')
    expect(answered?.payload.interactivePrompt).toBeUndefined()
  })

  it('does not re-assert the AskUserQuestion prompt on PostToolUse', () => {
    // The question was answered, so PostToolUse must clear the live card instead
    // of re-deriving the `{questions}` prompt from the carried tool input.
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'Pick', options: ['a'] }] }
        }
      },
      'production'
    )
    expect(event?.payload.toolName).toBe('AskUserQuestion')
    expect(event?.payload.interactivePrompt).toBeUndefined()
  })

  it('captures interactivePrompt for the OpenCode AskUserQuestion route', () => {
    const properties = { questions: [{ question: 'Choose', options: ['x', 'y'] }] }
    const event = normalizeHookPayload(
      state,
      'opencode',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'AskUserQuestion', ...properties }
      },
      'production'
    )
    expect(event?.payload.state).toBe('waiting')
    expect(event?.payload.interactivePrompt).toBe(JSON.stringify(properties))
  })
})
