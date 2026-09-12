import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { makePaneKey } from './stable-pane-id'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('Codex SessionStart listener obligations', () => {
  it('keeps Codex SessionStart metadata without treating it as working', () => {
    const state = createHookListenerState()
    const started = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'SessionStart',
          source: 'startup',
          session_id: 'codex-session-start'
        }
      },
      'production'
    )
    const prompted = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'ship the fix' }
      },
      'production'
    )

    expect(started).toBeNull()
    expect(prompted?.payload).toMatchObject({ state: 'working', prompt: 'ship the fix' })
    expect(prompted?.providerSession).toEqual({ key: 'session_id', id: 'codex-session-start' })
  })

  it('clears only the same-pane cached Codex status on SessionStart', () => {
    const state = createHookListenerState()
    const otherPane = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')
    const current = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'old session' }
      },
      'production'
    )
    const other = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: otherPane,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'other pane' }
      },
      'production'
    )
    if (!current || !other) {
      throw new Error('expected working status fixtures')
    }
    state.lastStatusByPaneKey.set(PANE_KEY, current)
    state.lastStatusByPaneKey.set(otherPane, other)

    const started = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'SessionStart', session_id: 'new-session' }
      },
      'production'
    )

    expect(started).toBeNull()
    expect(state.lastStatusByPaneKey.has(PANE_KEY)).toBe(false)
    expect(state.lastStatusByPaneKey.get(otherPane)).toBe(other)
  })

  it('does not clear a different agent status on Codex SessionStart', () => {
    const state = createHookListenerState()
    const claude = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'parent session' }
      },
      'production'
    )
    if (!claude) {
      throw new Error('expected Claude working status fixture')
    }
    state.lastStatusByPaneKey.set(PANE_KEY, claude)

    normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'SessionStart', session_id: 'nested-codex' }
      },
      'production'
    )

    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toBe(claude)
  })

  it('does not let a child hook replace the root SessionStart session id', () => {
    const state = createHookListenerState()
    normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'SessionStart', session_id: 'root-session' }
      },
      'production'
    )
    const child = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'SubagentStart',
          session_id: 'child-session',
          agent_id: 'child-session',
          agent_type: 'explorer'
        }
      },
      'production'
    )
    const prompted = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'continue' }
      },
      'production'
    )

    expect(child?.providerSession).toBeUndefined()
    expect(prompted?.providerSession).toEqual({ key: 'session_id', id: 'root-session' })
  })

  it('keeps Codex subagent events working and only root Stop done', () => {
    const state = createHookListenerState()
    normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'review this PR' }
      },
      'production'
    )
    const subStart = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'SubagentStart',
          agent_id: 'agent-1',
          agent_type: 'explorer'
        }
      },
      'production'
    )
    const subStop = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'SubagentStop',
          agent_id: 'agent-1',
          agent_type: 'explorer',
          last_assistant_message: 'Found 3 call sites'
        }
      },
      'production'
    )
    const stop = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'Stop',
          last_assistant_message: 'PR review complete'
        }
      },
      'production'
    )

    expect(subStart?.payload).toMatchObject({
      state: 'working',
      agentType: 'codex',
      toolName: 'explorer',
      prompt: 'review this PR'
    })
    expect(subStart?.toolAgentId).toBe('agent-1')
    expect(subStop?.payload).toMatchObject({
      state: 'working',
      lastAssistantMessage: 'Found 3 call sites',
      prompt: 'review this PR'
    })
    expect(stop?.payload).toMatchObject({
      state: 'done',
      lastAssistantMessage: 'PR review complete'
    })
  })

  it('promotes Codex PostToolUse tool_response into lastAssistantMessage', () => {
    const state = createHookListenerState()
    const event = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_response: 'README.md\nsrc\n'
        }
      },
      'production'
    )

    expect(event?.payload).toMatchObject({
      state: 'working',
      toolName: 'Bash',
      toolInput: 'ls',
      lastAssistantMessage: 'README.md\nsrc'
    })
  })

  it('previews Codex Bash cmd, apply_patch command, and spawn_agent prompt inputs', () => {
    const state = createHookListenerState()
    const bash = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { cmd: 'pwd' }
        }
      },
      'production'
    )
    const patch = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'apply_patch',
          tool_input: { command: '*** Begin Patch\n*** Update File: a.ts\n*** End Patch' }
        }
      },
      'production'
    )
    const spawn = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'spawn_agent',
          tool_input: { agent_type: 'explorer', prompt: 'find auth handlers' }
        }
      },
      'production'
    )

    expect(bash?.payload.toolInput).toBe('pwd')
    expect(patch?.payload.toolInput).toContain('Begin Patch')
    expect(spawn?.payload.toolInput).toBe('find auth handlers')
  })

  it('clears sticky Codex working when a tool event carries an interrupt marker', () => {
    const state = createHookListenerState()
    normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'run tests' }
      },
      'production'
    )
    const interrupted = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'pnpm test' },
          is_interrupt: true
        }
      },
      'production'
    )

    expect(interrupted?.payload).toMatchObject({
      state: 'done',
      interrupted: true,
      prompt: 'run tests'
    })
  })
})
