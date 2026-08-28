import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from './agent-hook-listener/grok-result-discovery'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  clearGrokSessionPathLookupCacheForTests,
  findGrokChatHistoryBySessionId
} from './grok-session-paths'
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

  it('normalizes Grok hookEventName payloads and keeps prompt across tool events', () => {
    const prompt = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        payload: { hookEventName: 'user_prompt_submit', prompt: 'run the check' }
      },
      'production'
    )
    expect(prompt).not.toBeNull()
    expect(prompt!.payload).toMatchObject({
      state: 'working',
      prompt: 'run the check',
      agentType: 'grok'
    })

    const tool = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        payload: {
          hookEventName: 'pre_tool_use',
          toolName: 'run_terminal_cmd',
          toolInput: { command: 'pnpm test' }
        }
      },
      'production'
    )
    expect(tool).not.toBeNull()
    expect(tool!.payload).toMatchObject({
      state: 'working',
      prompt: 'run the check',
      agentType: 'grok',
      toolName: 'run_terminal_cmd',
      toolInput: 'pnpm test'
    })
  })

  it('previews Grok-native tool names (run_terminal_command / search_replace)', () => {
    const shell = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'PreToolUse',
          tool_name: 'run_terminal_command',
          tool_input: { command: 'git status' }
        }
      },
      'production'
    )
    const edit = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'PreToolUse',
          toolName: 'search_replace',
          toolInput: { path: 'src/app.ts', old_string: 'a', new_string: 'b' }
        }
      },
      'production'
    )
    expect(shell?.payload).toMatchObject({
      agentType: 'grok',
      state: 'working',
      toolName: 'run_terminal_command',
      toolInput: 'git status'
    })
    expect(edit?.payload).toMatchObject({
      agentType: 'grok',
      state: 'working',
      toolName: 'search_replace',
      toolInput: 'src/app.ts'
    })
  })

  it('maps Grok ask_user_question PreToolUse to waiting with interactivePrompt', () => {
    const questions = [
      {
        question: 'Ship to which region?',
        options: [{ label: 'us-east', description: 'US East' }]
      }
    ]
    const waiting = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'PreToolUse',
          tool_name: 'ask_user_question',
          tool_input: { questions }
        }
      },
      'production'
    )
    const answered = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'post_tool_use',
          toolName: 'ask_user_question',
          toolInput: { questions },
          toolResponse: { selected: ['us-east'] }
        }
      },
      'production'
    )
    expect(waiting?.payload).toMatchObject({
      agentType: 'grok',
      state: 'waiting',
      toolName: 'ask_user_question'
    })
    expect(waiting?.payload.interactivePrompt).toContain('Ship to which region?')
    expect(answered?.payload).toMatchObject({
      agentType: 'grok',
      state: 'working',
      toolName: 'ask_user_question'
    })
    expect(answered?.payload.interactivePrompt).toBeUndefined()
  })

  it('does not recreate a Grok question card on post_tool_use_failure', () => {
    const event = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'post_tool_use_failure',
          toolName: 'ask_user_question',
          toolInput: { questions: [{ question: 'Retry?', options: ['yes', 'no'] }] },
          error: 'cancelled'
        }
      },
      'production'
    )

    expect(event?.payload.state).toBe('working')
    expect(event?.payload.interactivePrompt).toBeUndefined()
  })

  it('surfaces the Grok tool-failure error and clears stale tool fields', () => {
    normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'pre_tool_use',
          toolName: 'run_terminal_command',
          toolInput: { command: 'pnpm build' }
        }
      },
      'production'
    )
    const failed = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'post_tool_use_failure',
          toolName: 'run_terminal_command',
          toolInput: { command: 'pnpm build' },
          error: 'command exited with code 1'
        }
      },
      'production'
    )
    // Why: keeping toolName set would let the compact sidebar show the tool
    // instead of the failure text, hiding the error from the user.
    expect(failed?.payload).toMatchObject({
      state: 'working',
      lastAssistantMessage: 'command exited with code 1'
    })
    expect(failed?.payload.toolName).toBeUndefined()
    expect(failed?.payload.toolInput).toBeUndefined()
  })

  it('maps Grok StopFailure to done', () => {
    normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: { hookEventName: 'UserPromptSubmit', prompt: 'do work' }
      },
      'production'
    )
    const done = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: { hookEventName: 'StopFailure', error: 'api timeout' }
      },
      'production'
    )
    expect(done?.payload).toMatchObject({
      agentType: 'grok',
      state: 'done',
      prompt: 'do work'
    })
  })

  it('strips Grok internal user_query wrapper before caching the prompt', () => {
    const prompt = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'user_prompt_submit',
          prompt: '<user_query>\nFind recent PR\n</user_query>'
        }
      },
      'production'
    )
    expect(prompt?.payload.prompt).toBe('Find recent PR')

    const tool = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'pre_tool_use',
          toolName: 'web_search',
          toolInput: { query: 'recent PR' }
        }
      },
      'production'
    )
    expect(tool?.payload.prompt).toBe('Find recent PR')
  })

  it('strips Grok opening user_query wrapper even when the closing tag is absent', () => {
    const event = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: { hookEventName: 'user_prompt_submit', prompt: '<user_query>Find recent PR' }
      },
      'production'
    )
    expect(event?.payload.prompt).toBe('Find recent PR')
  })

  it('strips newline-heavy Grok user_query wrappers without regex matching', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const promptText = 'Find recent PR\n'.repeat(300)
    const event = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'user_prompt_submit',
          prompt: `<user_query>\n${promptText}</user_query>`
        }
      },
      'production'
    )

    expect(event?.payload.prompt).toContain('Find recent PR')
    expect(event?.payload.prompt).not.toContain('<user_query>')
    expect(event?.payload.prompt).not.toContain('</user_query>')
    const usedGrokWrapperMatch = matchSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        pattern.source.startsWith('^<user_query>') &&
        pattern.source.includes('[\\s\\S]')
    )
    expect(usedGrokWrapperMatch).toBe(false)
  })

  it('maps Grok feedback notifications to waiting without overwriting the prompt', () => {
    normalizeHookPayload(
      state,
      'grok',
      { paneKey: PANE_KEY, payload: { hookEventName: 'UserPromptSubmit', prompt: 'ship it' } },
      'production'
    )

    const event = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: { hookEventName: 'Notification', message: 'Grok needs your feedback to proceed' }
      },
      'production'
    )

    expect(event).not.toBeNull()
    expect(event!.payload).toMatchObject({
      state: 'waiting',
      prompt: 'ship it',
      agentType: 'grok'
    })
  })

  it('ignores Grok routine permission prompt notifications during tool use', () => {
    normalizeHookPayload(
      state,
      'grok',
      { paneKey: PANE_KEY, payload: { hookEventName: 'UserPromptSubmit', prompt: 'ship it' } },
      'production'
    )
    normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'PreToolUse',
          toolName: 'Shell',
          toolInput: { command: 'echo hi' }
        }
      },
      'production'
    )

    const event = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'Notification',
          notificationType: 'permission_prompt',
          message: 'Tool permission requested',
          level: 'info'
        }
      },
      'production'
    )

    expect(event).toBeNull()
  })

  it('enriches Grok Stop from chat history despite a generic status message', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-grok-session-'))
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf528'
    const cwd = join(tmpDir, 'workspace')
    const sessionDir = join(tmpDir, '.grok', 'sessions', encodeURIComponent(cwd), sessionId)
    try {
      vi.stubEnv('HOME', tmpDir)
      vi.stubEnv('USERPROFILE', tmpDir)
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'chat_history.jsonl'),
        `${[
          JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hihi' }] }),
          JSON.stringify({ type: 'assistant', content: 'Hi! How can I help you today?' })
        ].join('\n')}\n`
      )

      normalizeHookPayload(
        state,
        'grok',
        { paneKey: PANE_KEY, payload: { hookEventName: 'user_prompt_submit', prompt: 'hihi' } },
        'production'
      )

      const body = {
        paneKey: PANE_KEY,
        payload: { hookEventName: 'Stop', sessionId, cwd, message: 'Session completed' }
      }
      expect(hasPendingAgentResultText('grok', body)).toBe(true)
      const done = normalizeHookPayload(state, 'grok', body, 'production')

      expect(done?.payload.state).toBe('done')
      expect(done?.payload.lastAssistantMessage).toBe('Hi! How can I help you today?')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses the hook envelope Grok home instead of the listener service environment', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-grok-envelope-home-'))
    const serviceGrokHome = join(tmpDir, 'service-grok')
    const hookGrokHome = join(tmpDir, 'hook-grok')
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf529'
    const cwd = join(tmpDir, 'workspace')
    const sessionDir = join(hookGrokHome, 'sessions', encodeURIComponent(cwd), sessionId)
    try {
      vi.stubEnv('GROK_HOME', serviceGrokHome)
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'chat_history.jsonl'),
        `${JSON.stringify({ type: 'assistant', content: 'from effective Grok home' })}\n`
      )

      const done = normalizeHookPayload(
        state,
        'grok',
        {
          paneKey: PANE_KEY,
          grokHome: hookGrokHome,
          payload: { hookEventName: 'Stop', sessionId, cwd }
        },
        'production'
      )

      expect(done?.payload.lastAssistantMessage).toBe('from effective Grok home')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it.each([
    'relative/grok-home',
    join(tmpdir(), 'x'.repeat(4096)),
    `${join(tmpdir(), 'grok-home')}\ninvalid`
  ])('ignores invalid hook-envelope Grok home %s', (grokHome) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-grok-invalid-home-'))
    const serviceGrokHome = join(tmpDir, 'service-grok')
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf530'
    const cwd = join(tmpDir, 'workspace')
    const sessionDir = join(serviceGrokHome, 'sessions', encodeURIComponent(cwd), sessionId)
    try {
      vi.stubEnv('GROK_HOME', serviceGrokHome)
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'chat_history.jsonl'),
        `${JSON.stringify({ type: 'assistant', content: 'fallback result' })}\n`
      )

      const done = normalizeHookPayload(
        state,
        'grok',
        {
          paneKey: PANE_KEY,
          grokHome,
          payload: { hookEventName: 'Stop', sessionId, cwd }
        },
        'production'
      )

      expect(done?.payload.lastAssistantMessage).toBe('fallback result')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not let Grok sessionId escape the chat-history directory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-grok-session-escape-'))
    const cwd = join(tmpDir, 'workspace')
    const escapedDir = join(tmpDir, '.grok', 'sessions', 'escaped')
    try {
      vi.stubEnv('HOME', tmpDir)
      vi.stubEnv('USERPROFILE', tmpDir)
      mkdirSync(escapedDir, { recursive: true })
      writeFileSync(
        join(escapedDir, 'chat_history.jsonl'),
        `${JSON.stringify({ type: 'assistant', content: 'should not leak' })}\n`
      )

      const done = normalizeHookPayload(
        state,
        'grok',
        {
          paneKey: PANE_KEY,
          payload: { hookEventName: 'Stop', sessionId: '../escaped', cwd }
        },
        'production'
      )

      expect(done?.payload.state).toBe('done')
      expect(done?.payload.lastAssistantMessage).toBeUndefined()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('treats Grok SessionEnd chat history as pending result text', () => {
    expect(
      hasPendingAgentResultText('grok', {
        payload: {
          hookEventName: 'SessionEnd',
          sessionId: '019e37f4-5135-7b63-a4ab-6d13aa6bf528',
          cwd: '/tmp/workspace'
        }
      })
    ).toBe(true)
  })

  it('enriches a long-cwd Grok result after async discovery completes', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-grok-pending-home-'))
    const hookGrokHome = join(tmpDir, 'hook-grok')
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf531'
    const cwd = `/${'long-workspace/'.repeat(30)}`
    const sessionDir = join(hookGrokHome, 'sessions', 'workspace-slug', sessionId)
    try {
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'chat_history.jsonl'),
        `${JSON.stringify({ type: 'assistant', content: 'from slug session' })}\n`
      )

      const body = {
        paneKey: PANE_KEY,
        grokHome: hookGrokHome,
        payload: { hookEventName: 'SessionEnd', sessionId, cwd }
      }
      const discovery = preparePendingGrokResultDiscovery('grok', body)
      expect(discovery).not.toBeNull()
      await discovery
      await expect(
        findGrokChatHistoryBySessionId(join(hookGrokHome, 'sessions'), sessionId)
      ).resolves.toBe(join(sessionDir, 'chat_history.jsonl'))

      const done = normalizeHookPayload(state, 'grok', body, 'production')
      expect(done?.payload.lastAssistantMessage).toBe('from slug session')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not schedule Grok discovery for an invalid session id', () => {
    expect(
      hasPendingAgentResultText('grok', {
        payload: {
          hookEventName: 'SessionEnd',
          sessionId: '../escape',
          cwd: '/tmp/workspace'
        }
      })
    ).toBe(false)
  })
})
