import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { hasPendingAgentResultText } from './agent-hook-listener/grok-result-discovery'
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

  // Windows can post empty stdin verbatim while POSIX substitutes {}; both must transition (#15117).
  it('accepts an Antigravity event whose payload is empty or whitespace-only', () => {
    for (const payload of ['', '   ', '\r\n']) {
      const started = normalizeHookPayload(
        state,
        'antigravity',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt',
          hook_event_name: 'PreInvocation',
          payload
        },
        'production'
      )
      expect(started?.payload, `payload ${JSON.stringify(payload)}`).toMatchObject({
        state: 'working',
        agentType: 'antigravity'
      })
    }
  })

  // Windows curl can omit the field entirely when no stdin arrives (#15117).
  it('accepts an Antigravity event that carries no payload key at all', () => {
    const started = normalizeHookPayload(
      state,
      'antigravity',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt',
        hook_event_name: 'PreInvocation'
      },
      'production'
    )
    expect(started?.payload).toMatchObject({ state: 'working', agentType: 'antigravity' })
  })

  it('still drops an Antigravity event whose payload is malformed rather than empty', () => {
    expect(
      normalizeHookPayload(
        state,
        'antigravity',
        {
          paneKey: PANE_KEY,
          hook_event_name: 'PreInvocation',
          payload: '{"prompt":'
        },
        'production'
      )
    ).toBeNull()
  })

  it('keeps Gemini rejection of empty or missing payloads', () => {
    for (const payload of ['', undefined]) {
      expect(
        normalizeHookPayload(
          state,
          'gemini',
          {
            paneKey: PANE_KEY,
            hook_event_name: 'BeforeAgent',
            ...(payload === undefined ? {} : { payload })
          },
          'production'
        )
      ).toBeNull()
    }
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

    // Managed hooks can lack stdin; event name alone still establishes status.
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

  it('reads a bounded preview from newline-heavy Antigravity user requests', () => {
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

      expect(started?.payload.prompt).toBe(
        'Fix the failing test Fix the failing test Fix the failing test Fix the failing test Fix the failing test Fix the failing test Fix the failing test Fix the failing test Fix the failing test Fix the fai'
      )
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
    expect(event?.payload.mainAgent).toBeUndefined()
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

  // Event order captured from agy 1.4.7 (#17650); transcript contents below are synthetic, not origin evidence.
  it('keeps an Antigravity parent working until its own idle Stop when a subagent finishes', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-antigravity-subagent-'))
    const writeTranscript = (name: string, request: string, reply: string): string => {
      const path = join(tmpDir, `${name}.jsonl`)
      writeFileSync(
        path,
        `${[
          JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: request }),
          JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: reply })
        ].join('\n')}\n`
      )
      return path
    }
    const parent = {
      conversationId: 'parent-conversation',
      lastUserInput: 'translate',
      transcriptPath: writeTranscript('parent', 'translate', 'Parent final report')
    }
    const child = {
      conversationId: 'child-conversation',
      lastUserInput: '',
      transcriptPath: writeTranscript('child', 'translate to fr', 'Subagent report')
    }
    const subagentCall = { name: 'invoke_subagent', args: { TypeName: 'self', Prompt: 'fr' } }
    const send = (hookEventName: string, payload: Record<string, unknown>) =>
      normalizeHookPayload(
        state,
        'antigravity',
        { paneKey: PANE_KEY, hook_event_name: hookEventName, payload },
        'production'
      )?.payload ?? null

    try {
      const events = [
        send('PreInvocation', parent),
        send('PreToolUse', { ...parent, toolCall: subagentCall }),
        send('PostToolUse', { ...parent, toolCall: subagentCall }),
        send('PreInvocation', child),
        send('Stop', { ...parent, fullyIdle: false }),
        send('PostInvocation', child),
        send('Stop', { ...child, fullyIdle: true }),
        send('PreInvocation', parent)
      ]
      expect(events.map((event) => event?.state ?? null)).toEqual([
        'working',
        'working',
        'working',
        null,
        'working',
        null,
        null,
        'working'
      ])
      // Held open for helpers, so the terminal's done for the parent's turn cannot settle it.
      expect(events[4]?.mainAgent?.state).toBe('done')

      const done = normalizeHookPayload(
        state,
        'antigravity',
        { paneKey: PANE_KEY, hook_event_name: 'Stop', payload: { ...parent, fullyIdle: true } },
        'production'
      )
      expect(done?.payload).toMatchObject({
        state: 'done',
        lastAssistantMessage: 'Parent final report'
      })
      expect(send('PostToolUse', { ...parent, toolCall: subagentCall })).toBeNull()
      expect(send('PreInvocation', parent)?.state).toBe('working')
      const nextStop = send('Stop', { ...parent, fullyIdle: false })
      expect(nextStop?.state).toBe('working')
      expect(nextStop?.mainAgent).toBeUndefined()
      expect(
        send('PreInvocation', { conversationId: 'next-conversation', lastUserInput: 'next' })?.state
      ).toBe('working')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('tracks a new Antigravity conversation after the parent exits mid-subagent', () => {
    const send = (hookEventName: string, payload: Record<string, unknown>) =>
      normalizeHookPayload(
        state,
        'antigravity',
        { paneKey: PANE_KEY, hook_event_name: hookEventName, payload },
        'production'
      )?.payload.state ?? null
    const parent = { conversationId: 'parent-conversation', lastUserInput: 'translate' }
    send('PreInvocation', parent)
    send('PreToolUse', { ...parent, toolCall: { name: 'invoke_subagent', args: {} } })
    expect(send('PreInvocation', { conversationId: 'child', lastUserInput: '' })).toBeNull()

    // agy was quit mid-subagent, so no idle Stop ever closed the parent; the user relaunched it.
    const next = { conversationId: 'next-conversation', lastUserInput: 'hello' }
    expect([
      send('PreInvocation', next),
      send('PreToolUse', { ...next, toolCall: { name: 'ask_question', args: {} } }),
      send('Stop', { ...next, fullyIdle: true })
    ]).toEqual(['working', 'waiting', 'done'])
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

  it('does not mark Copilot result text pending when a generic message is present', () => {
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
})
