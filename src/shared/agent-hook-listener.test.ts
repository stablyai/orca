/* eslint-disable max-lines -- Why: this fixture keeps cross-agent hook normalization and cache behavior together so regressions in shared listener state are visible. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createHookListenerState,
  getEndpointFileName,
  hasPendingAgentResultText,
  isShellSafeEndpointValue,
  normalizeHookPayload,
  parseFormEncodedBody,
  resolveHookSource,
  writeEndpointFile,
  type HookListenerState
} from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('parses form-encoded bodies', () => {
    const decoded = parseFormEncodedBody('paneKey=tab-1%3A0&worktreeId=foo')
    expect(decoded.paneKey).toBe('tab-1:0')
    expect(decoded.worktreeId).toBe('foo')
  })

  it('routes pathnames to a known source or null', () => {
    expect(resolveHookSource('/hook/claude')).toBe('claude')
    expect(resolveHookSource('/hook/cursor')).toBe('cursor')
    expect(resolveHookSource('/hook/antigravity')).toBe('antigravity')
    expect(resolveHookSource('/hook/grok')).toBe('grok')
    expect(resolveHookSource('/hook/hermes')).toBe('hermes')
    expect(resolveHookSource('/hook/pi')).toBe('pi')
    expect(resolveHookSource('/hook/omp')).toBe('omp')
    expect(resolveHookSource('/hook/command-code')).toBe('command-code')
    expect(resolveHookSource('/hook/unknown')).toBeNull()
    expect(resolveHookSource('/')).toBeNull()
  })

  it('rejects shell-unsafe endpoint values', () => {
    expect(isShellSafeEndpointValue('1234')).toBe(true)
    expect(isShellSafeEndpointValue('abc-DEF.0_1')).toBe(true)
    expect(isShellSafeEndpointValue('')).toBe(false)
    expect(isShellSafeEndpointValue('foo&bar')).toBe(false)
    expect(isShellSafeEndpointValue('foo bar')).toBe(false)
    expect(isShellSafeEndpointValue('foo;bar')).toBe(false)
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
  })

  it('normalizes Command Code hooks and reads turn text from the transcript', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-transcript-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      writeFileSync(
        transcriptPath,
        `${[
          JSON.stringify({
            role: 'user',
            content: [{ type: 'text', text: 'Run pwd and report it' }]
          }),
          JSON.stringify({
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Need to run pwd.' },
              { type: 'text', text: 'The output is /tmp/project.' }
            ]
          })
        ].join('\n')}\n`
      )

      const tool = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt',
          env: 'production',
          version: '1',
          payload: {
            hook_event_name: 'PreToolUse',
            transcript_path: transcriptPath,
            tool_name: 'shell_command',
            tool_input: { command: 'pwd' }
          }
        },
        'production'
      )
      expect(tool?.payload).toMatchObject({
        state: 'working',
        prompt: 'Run pwd and report it',
        agentType: 'command-code',
        toolName: 'shell_command',
        toolInput: 'pwd'
      })

      const done = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt',
          env: 'production',
          version: '1',
          payload: {
            hook_event_name: 'Stop',
            transcript_path: transcriptPath
          }
        },
        'production'
      )
      expect(done?.payload).toMatchObject({
        state: 'done',
        prompt: 'Run pwd and report it',
        agentType: 'command-code',
        lastAssistantMessage: 'The output is /tmp/project.'
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('trims surrounding whitespace from extracted prompt text', () => {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: '   hi   ' }
      },
      'production'
    )
    expect(event).not.toBeNull()
    expect(event!.payload.prompt).toBe('hi')
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

  it('normalizes Antigravity invocation and tool hooks', () => {
    const started = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        hook_event_name: 'PreInvocation',
        payload: { prompt: 'run tests' }
      },
      'production'
    )
    expect(started?.payload).toMatchObject({
      state: 'working',
      prompt: 'run tests',
      agentType: 'antigravity'
    })

    const tool = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        hook_event_name: 'PreToolUse',
        payload: {
          toolCall: {
            name: 'run_command',
            args: { CommandLine: 'pnpm test' }
          }
        }
      },
      'production'
    )
    expect(tool?.payload).toMatchObject({
      state: 'working',
      prompt: 'run tests',
      agentType: 'antigravity',
      toolName: 'run_command',
      toolInput: 'pnpm test'
    })
  })

  it('normalizes Antigravity events even when the hook body is empty', () => {
    const started = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        hook_event_name: 'PreInvocation',
        payload: {}
      },
      'production'
    )

    // Why: Antigravity can invoke managed hooks without stdin. The wrapper
    // posts `{}` in that case, and the event name is still enough to keep the
    // visible status alive.
    expect(started?.payload).toMatchObject({
      state: 'working',
      prompt: '',
      agentType: 'antigravity'
    })
  })

  it('reads Antigravity user requests from the transcript', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-antigravity-prompt-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          content:
            '<USER_REQUEST>\nFix the failing test\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nignored\n</ADDITIONAL_METADATA>'
        })}\n`
      )

      const started = normalizeHookPayload(
        state,
        'antigravity',
        {
          paneKey: PANE_KEY,
          hook_event_name: 'PreInvocation',
          payload: { transcriptPath }
        },
        'production'
      )

      expect(started?.payload).toMatchObject({
        state: 'working',
        prompt: 'Fix the failing test',
        agentType: 'antigravity'
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('keeps the cached Antigravity prompt instead of rescanning the transcript', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-antigravity-cached-prompt-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          content: '<USER_REQUEST>\nFirst request\n</USER_REQUEST>'
        })}\n`
      )

      const started = normalizeHookPayload(
        state,
        'antigravity',
        {
          paneKey: PANE_KEY,
          hook_event_name: 'PreInvocation',
          payload: { transcriptPath }
        },
        'production'
      )
      expect(started?.payload.prompt).toBe('First request')

      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          content: '<USER_REQUEST>\nSecond request\n</USER_REQUEST>'
        })}\n`,
        { flag: 'a' }
      )

      const tool = normalizeHookPayload(
        state,
        'antigravity',
        {
          paneKey: PANE_KEY,
          hook_event_name: 'PostToolUse',
          payload: { transcriptPath, toolCall: { name: 'run_command' } }
        },
        'production'
      )

      expect(tool?.payload.prompt).toBe('First request')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('maps Antigravity feedback tools to waiting state', () => {
    const question = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        hook_event_name: 'PreToolUse',
        payload: {
          toolCall: {
            name: 'ask_question',
            args: { Prompt: 'Which path should I use?' }
          }
        }
      },
      'production'
    )
    expect(question?.payload).toMatchObject({
      state: 'waiting',
      agentType: 'antigravity',
      toolName: 'ask_question',
      toolInput: 'Which path should I use?'
    })

    const permission = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        hook_event_name: 'PreToolUse',
        payload: {
          toolCall: {
            name: 'ask_permission',
            args: { Action: 'run command', Target: 'pnpm lint' }
          }
        }
      },
      'production'
    )
    expect(permission?.payload).toMatchObject({
      state: 'waiting',
      agentType: 'antigravity',
      toolName: 'ask_permission',
      toolInput: 'run command'
    })
  })

  it('resets Antigravity tool state on a new invocation', () => {
    normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        hook_event_name: 'PreToolUse',
        payload: {
          toolCall: { name: 'run_command', args: { CommandLine: 'pnpm test' } }
        }
      },
      'production'
    )

    const nextTurn = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        hook_event_name: 'PreInvocation',
        payload: { prompt: 'new task' }
      },
      'production'
    )

    expect(nextTurn?.payload).toMatchObject({
      state: 'working',
      prompt: 'new task',
      agentType: 'antigravity'
    })
    expect(nextTurn?.payload.toolName).toBeUndefined()
    expect(nextTurn?.payload.toolInput).toBeUndefined()
  })

  it('normalizes Antigravity Stop hooks and reads final text from the transcript', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-antigravity-transcript-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      writeFileSync(
        transcriptPath,
        `${[
          JSON.stringify({ source: 'USER', type: 'REQUEST', content: 'hi' }),
          JSON.stringify({
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            content: 'Antigravity is wired up.'
          })
        ].join('\n')}\n`
      )

      const done = normalizeHookPayload(
        state,
        'antigravity',
        {
          paneKey: PANE_KEY,
          hook_event_name: 'Stop',
          payload: { fullyIdle: true, transcriptPath }
        },
        'production'
      )

      expect(done?.payload).toMatchObject({
        state: 'done',
        prompt: 'hi',
        agentType: 'antigravity',
        lastAssistantMessage: 'Antigravity is wired up.'
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('keeps Antigravity Stop working while fullyIdle is false', () => {
    const event = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        hook_event_name: 'Stop',
        payload: { fullyIdle: false }
      },
      'production'
    )

    expect(event?.payload).toMatchObject({
      state: 'working',
      agentType: 'antigravity'
    })
  })

  it('keeps Antigravity tool hooks active after a non-idle Stop for the same transcript', () => {
    const transcriptPath = '/tmp/antigravity-non-idle-transcript.jsonl'
    const stop = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        hook_event_name: 'Stop',
        payload: { transcriptPath, fullyIdle: false }
      },
      'production'
    )
    expect(stop?.payload.state).toBe('working')

    const nextTool = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        hook_event_name: 'PostToolUse',
        payload: {
          transcriptPath,
          toolCall: { name: 'run_command', args: { CommandLine: 'pwd' } }
        }
      },
      'production'
    )

    expect(nextTool?.payload).toMatchObject({
      state: 'working',
      agentType: 'antigravity',
      toolName: 'run_command',
      toolInput: 'pwd'
    })
  })

  it('ignores late Antigravity tool hooks after a completed Stop for the same transcript', () => {
    const transcriptPath = '/tmp/antigravity-transcript.jsonl'
    const done = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        hook_event_name: 'Stop',
        payload: { transcriptPath, fullyIdle: true }
      },
      'production'
    )
    expect(done?.payload.state).toBe('done')

    const lateTool = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        hook_event_name: 'PostToolUse',
        payload: {
          transcriptPath,
          toolCall: { name: 'run_command', args: { CommandLine: 'pwd' } }
        }
      },
      'production'
    )

    expect(lateTool).toBeNull()
  })

  it('treats Antigravity Stop transcripts as pending result text', () => {
    expect(
      hasPendingAgentResultText('antigravity', {
        hook_event_name: 'Stop',
        payload: { transcriptPath: '/tmp/antigravity-transcript.jsonl' }
      })
    ).toBe(true)
    expect(
      hasPendingAgentResultText('antigravity', {
        hook_event_name: 'Stop',
        payload: {
          transcriptPath: '/tmp/antigravity-transcript.jsonl',
          last_assistant_message: 'done'
        }
      })
    ).toBe(false)
    expect(
      hasPendingAgentResultText('antigravity', {
        hook_event_name: 'Stop',
        payload: { fullyIdle: false, transcriptPath: '/tmp/antigravity-transcript.jsonl' }
      })
    ).toBe(false)
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

  it('reads Grok final assistant text from chat history on Stop', () => {
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

      const done = normalizeHookPayload(
        state,
        'grok',
        {
          paneKey: PANE_KEY,
          payload: { hookEventName: 'Stop', sessionId, cwd }
        },
        'production'
      )

      expect(done?.payload.state).toBe('done')
      expect(done?.payload.lastAssistantMessage).toBe('Hi! How can I help you today?')
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

  describe('writeEndpointFile', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'agent-hook-listener-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('writes the endpoint file atomically with the right contents and mode', () => {
      const finalPath = join(dir, getEndpointFileName())
      const ok = writeEndpointFile(dir, finalPath, {
        port: 12345,
        token: 'abcdef-0123',
        env: 'production',
        version: '1'
      })
      expect(ok).toBe(true)
      const text = readFileSync(finalPath, 'utf8')
      expect(text).toContain('ORCA_AGENT_HOOK_PORT=12345')
      expect(text).toContain('ORCA_AGENT_HOOK_TOKEN=abcdef-0123')
      expect(text).toContain('ORCA_AGENT_HOOK_VERSION=1')
      // POSIX 0o600 — owner read/write only.
      if (process.platform !== 'win32') {
        const mode = statSync(finalPath).mode & 0o777
        expect(mode).toBe(0o600)
      }
    })

    it('refuses unsafe values', () => {
      const finalPath = join(dir, getEndpointFileName())
      const ok = writeEndpointFile(dir, finalPath, {
        port: 12345,
        token: 'safe-token',
        env: 'foo&bar',
        version: '1'
      })
      expect(ok).toBe(false)
    })
  })
})
