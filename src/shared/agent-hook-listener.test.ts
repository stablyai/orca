/* eslint-disable max-lines -- Why: this fixture keeps cross-agent hook normalization and cache behavior together so regressions in shared listener state are visible. */
import { EventEmitter } from 'node:events'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHookListenerState,
  getEndpointFileName,
  hasPendingAgentResultText,
  HOOK_REQUEST_MAX_BYTES,
  isShellSafeEndpointValue,
  normalizeHookPayload,
  parseFormEncodedBody,
  preparePendingGrokResultDiscovery,
  readRequestBody,
  resolveHookSource,
  writeEndpointFile,
  type HookListenerState
} from './agent-hook-listener'
import {
  clearGrokSessionPathLookupCacheForTests,
  findGrokChatHistoryBySessionId
} from './grok-session-paths'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

type FakeIncomingMessage = EventEmitter & {
  headers: IncomingHttpHeaders
  destroy: ReturnType<typeof vi.fn>
}

function createReadableRequest(headers: IncomingHttpHeaders = {}): FakeIncomingMessage {
  const req = new EventEmitter() as FakeIncomingMessage
  req.headers = headers
  req.destroy = vi.fn(() => req.emit('close'))
  return req
}

function expectRequestParserListenersReleased(req: FakeIncomingMessage): void {
  expect(req.listenerCount('data')).toBe(0)
  expect(req.listenerCount('end')).toBe(0)
  expect(req.listenerCount('close')).toBe(0)
  expect(req.listenerCount('error')).toBe(1)
  expect(() => req.emit('error', new Error('late request error'))).not.toThrow()
}

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    clearGrokSessionPathLookupCacheForTests()
    vi.unstubAllEnvs()
  })

  it('parses form-encoded bodies', () => {
    const decoded = parseFormEncodedBody('paneKey=tab-1%3A0&worktreeId=foo')
    expect(decoded.paneKey).toBe('tab-1:0')
    expect(decoded.worktreeId).toBe('foo')
  })

  it('releases request parser listeners after reading a JSON body', async () => {
    const req = createReadableRequest({ 'content-type': 'application/json' })
    const body = readRequestBody(req as unknown as IncomingMessage)

    req.emit('data', Buffer.from('{"ok":true}'))
    req.emit('end')

    await expect(body).resolves.toEqual({ ok: true })
    expectRequestParserListenersReleased(req)
  })

  it('releases request parser listeners after rejecting an oversized body', async () => {
    const req = createReadableRequest({ 'content-type': 'application/json' })
    const body = readRequestBody(req as unknown as IncomingMessage)

    req.emit('data', Buffer.alloc(HOOK_REQUEST_MAX_BYTES + 1))

    await expect(body).rejects.toThrow('payload too large')
    expect(req.destroy).toHaveBeenCalledTimes(1)
    expectRequestParserListenersReleased(req)
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
    expect(resolveHookSource('/hook/mimo-code')).toBe('mimo-code')
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
      expect(tool?.hasExplicitPrompt).toBe(true)
      expect(tool?.promptInteractionKey).toMatch(/^command-code-transcript-[a-f0-9]{12}-/)

      const directPrompt = normalizeHookPayload(
        createHookListenerState(),
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'PreToolUse',
            prompt: 'Direct command prompt'
          }
        },
        'production'
      )
      expect(directPrompt?.hasExplicitPrompt).toBe(true)

      const directPromptWithTranscript = normalizeHookPayload(
        createHookListenerState(),
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'PreToolUse',
            prompt: 'Run pwd and report it',
            transcript_path: transcriptPath
          }
        },
        'production'
      )
      expect(directPromptWithTranscript?.hasExplicitPrompt).toBe(true)
      expect(directPromptWithTranscript?.promptInteractionKey).toBe(tool?.promptInteractionKey)

      const statusMessage = normalizeHookPayload(
        createHookListenerState(),
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'PreToolUse',
            message: 'Preparing tool call'
          }
        },
        'production'
      )
      expect(statusMessage?.hasExplicitPrompt).toBe(false)

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
      expect(done?.promptInteractionKey).toBe(tool?.promptInteractionKey)

      const cachedOnly = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt',
          env: 'production',
          version: '1',
          payload: {
            hook_event_name: 'Stop'
          }
        },
        'production'
      )
      expect(cachedOnly?.payload.prompt).toBe('Run pwd and report it')
      expect(cachedOnly?.hasExplicitPrompt).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reads newline-heavy Command Code transcripts without line-array splitting', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-command-code-large-transcript-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    try {
      const filler = Array.from({ length: 6_000 }, (_value, index) =>
        JSON.stringify({
          role: index % 2 === 0 ? 'assistant' : 'user',
          content: [{ type: 'text', text: `filler ${index}` }]
        })
      )
      writeFileSync(
        transcriptPath,
        `${[
          ...filler,
          JSON.stringify({
            role: 'user',
            content: [{ type: 'text', text: 'large transcript prompt' }]
          }),
          JSON.stringify({
            role: 'assistant',
            content: [{ type: 'text', text: 'large transcript answer' }]
          })
        ].join('\n')}\n`
      )
      const splitSpy = vi.spyOn(String.prototype, 'split')

      const tool = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'PreToolUse',
            transcript_path: transcriptPath,
            tool_name: 'shell_command',
            tool_input: { command: 'pwd' }
          }
        },
        'production'
      )
      const done = normalizeHookPayload(
        state,
        'command-code',
        {
          paneKey: PANE_KEY,
          payload: {
            hook_event_name: 'Stop',
            transcript_path: transcriptPath
          }
        },
        'production'
      )

      expect(tool?.payload.prompt).toBe('large transcript prompt')
      expect(done?.payload.lastAssistantMessage).toBe('large transcript answer')
      const usedLineArraySplit = splitSpy.mock.calls.some(
        ([separator]) => typeof separator === 'string' && separator === '\n'
      )
      expect(usedLineArraySplit).toBe(false)
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

  it('keeps the cached prompt when a harness-injected turn fires UserPromptSubmit', () => {
    normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { hook_event_name: 'UserPromptSubmit', prompt: 'fix login' } },
      'production'
    )
    // Why: the harness injects background task notifications as user turns;
    // they must not replace the user's real prompt in status labels.
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

  it('resolves an empty prompt for a harness-injected turn with nothing cached', () => {
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
    expect(event!.payload.prompt).toBe('')
    expect(event!.hasExplicitPrompt).toBe(false)
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
      expect(started?.hasExplicitPrompt).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reads newline-heavy Antigravity user requests without wrapper regex matching', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-antigravity-large-prompt-'))
    const transcriptPath = join(tmpDir, 'transcript.jsonl')
    const requestText = 'Fix the failing test\n'.repeat(300)
    try {
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          content: `<USER_REQUEST>\n${requestText}</USER_REQUEST>`
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

      expect(started?.payload.prompt).toContain('Fix the failing test')
      expect(started?.payload.prompt).not.toContain('<USER_REQUEST>')
      expect(started?.payload.prompt).not.toContain('</USER_REQUEST>')
      const usedRequestWrapperMatch = matchSpy.mock.calls.some(
        ([pattern]) =>
          pattern instanceof RegExp &&
          pattern.source.includes('<USER_REQUEST>') &&
          pattern.source.includes('[\\s\\S]')
      )
      expect(usedRequestWrapperMatch).toBe(false)
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

  it('lets Copilot Stop consume a generic message without scheduling transcript retry', () => {
    expect(
      hasPendingAgentResultText('copilot', {
        payload: {
          hookEventName: 'Stop',
          message: 'Copilot final response',
          transcript_path: '/tmp/copilot-transcript.jsonl'
        }
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
