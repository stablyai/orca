import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import './agent-hook-listener/grok-result-discovery'
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
})
