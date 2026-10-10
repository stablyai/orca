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

  it('rejects Codex hooks stamped by a shared daemon for another workspace', () => {
    const worktreeId = 'repo-a::/workspaces/FusionRF'
    const wrong = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        worktreeId,
        payload: {
          hook_event_name: 'PostToolUse',
          session_id: 'albedo-session',
          cwd: '/workspaces/Albedo',
          tool_name: 'Bash',
          tool_input: { command: 'echo from Albedo' }
        }
      },
      'production'
    )
    expect(wrong).toBeNull()
    expect(state.lastStatusByPaneKey.has(PANE_KEY)).toBe(false)

    const traversed = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        worktreeId,
        payload: {
          hook_event_name: 'PostToolUse',
          session_id: 'albedo-session',
          cwd: '/workspaces/FusionRF/../Albedo',
          tool_name: 'Bash'
        }
      },
      'production'
    )
    expect(traversed).toBeNull()
    expect(state.lastStatusByPaneKey.has(PANE_KEY)).toBe(false)

    const own = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        worktreeId,
        payload: {
          hook_event_name: 'PostToolUse',
          session_id: 'fusion-session',
          cwd: '/workspaces/FusionRF/crates',
          tool_name: 'Bash',
          tool_input: { command: 'echo from FusionRF' }
        }
      },
      'production'
    )
    expect(own?.providerSession?.id).toBe('fusion-session')
    expect(own?.payload.toolInput).toBe('echo from FusionRF')
  })

  it('accepts a WSL Codex hook whose Linux cwd matches the stamped UNC worktree', () => {
    const event = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        worktreeId: String.raw`repo::\\wsl.localhost\Ubuntu\home\alice\repo`,
        payload: {
          hook_event_name: 'PostToolUse',
          session_id: 'wsl-session',
          cwd: '/home/alice/repo/src',
          tool_name: 'Bash'
        }
      },
      'production'
    )
    expect(event?.providerSession?.id).toBe('wsl-session')

    const uncEvent = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        worktreeId: String.raw`repo::\\wsl.localhost\Ubuntu\home\alice\repo`,
        payload: {
          hook_event_name: 'PostToolUse',
          session_id: 'wsl-unc-session',
          cwd: String.raw`\\wsl.localhost\Ubuntu\home\alice\repo\src`,
          tool_name: 'Bash'
        }
      },
      'production'
    )
    expect(uncEvent?.providerSession?.id).toBe('wsl-unc-session')

    const outside = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        worktreeId: String.raw`repo::\\wsl.localhost\Ubuntu\home\alice\repo`,
        payload: {
          hook_event_name: 'PostToolUse',
          session_id: 'other-session',
          cwd: '/home/alice/repo/../other',
          tool_name: 'Bash'
        }
      },
      'production'
    )
    expect(outside).toBeNull()
  })

  it('normalizes Hermes pre_llm_call to a working turn with prompt text', () => {
    const event = normalizeHookPayload(
      state,
      'hermes',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        env: 'production',
        version: '1',
        payload: {
          hook_event_name: 'pre_llm_call',
          user_message: 'ship the Hermes support'
        }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.payload.state).toBe('working')
    expect(event!.payload.prompt).toBe('ship the Hermes support')
    expect(event!.payload.agentType).toBe('hermes')
  })

  it('normalizes Hermes tool calls and approval hooks', () => {
    normalizeHookPayload(
      state,
      'hermes',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'pre_llm_call',
          user_message: 'run tests'
        }
      },
      'production'
    )
    const tool = normalizeHookPayload(
      state,
      'hermes',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'pre_tool_call',
          tool_name: 'terminal',
          args: { command: 'pnpm test' }
        }
      },
      'production'
    )
    expect(tool?.payload.state).toBe('working')
    expect(tool?.payload.toolName).toBe('terminal')
    expect(tool?.payload.toolInput).toBe('pnpm test')
    expect(tool?.payload.prompt).toBe('run tests')

    const approval = normalizeHookPayload(
      state,
      'hermes',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'pre_approval_request',
          command: 'rm -rf build',
          description: 'Remove stale build output'
        }
      },
      'production'
    )
    expect(approval?.payload.state).toBe('waiting')
    expect(approval?.payload.toolName).toBe('approval')
    expect(approval?.payload.toolInput).toBe('rm -rf build')
  })

  it('normalizes Hermes first-party tool argument previews', () => {
    const execute = normalizeHookPayload(
      state,
      'hermes',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'pre_tool_call',
          tool_name: 'execute_code',
          args: { code: 'print("ok")' }
        }
      },
      'production'
    )
    expect(execute?.payload.toolName).toBe('execute_code')
    expect(execute?.payload.toolInput).toBe('print("ok")')

    const pluginTool = normalizeHookPayload(
      state,
      'hermes',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'pre_tool_call',
          tool_name: 'custom_plugin_tool',
          args: { query: 'agent hooks' }
        }
      },
      'production'
    )
    expect(pluginTool?.payload.toolName).toBe('custom_plugin_tool')
    expect(pluginTool?.payload.toolInput).toBe('agent hooks')
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

  it('keeps ordinary Codex PreToolUse mapped to working', () => {
    const working = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'shell',
          tool_input: { command: 'ls' }
        }
      },
      'production'
    )
    expect(working?.payload.state).toBe('working')
    expect(working?.payload.interactivePrompt).toBeUndefined()
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

  it('normalizes Hermes post_llm_call to done with assistant text', () => {
    normalizeHookPayload(
      state,
      'hermes',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'pre_llm_call',
          user_message: 'summarize'
        }
      },
      'production'
    )
    const done = normalizeHookPayload(
      state,
      'hermes',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'post_llm_call',
          assistant_response: 'Hermes is wired up.'
        }
      },
      'production'
    )
    expect(done?.payload.state).toBe('done')
    expect(done?.payload.prompt).toBe('summarize')
    expect(done?.payload.lastAssistantMessage).toBe('Hermes is wired up.')
  })
})
