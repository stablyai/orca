import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHookListenerState,
  hasPendingAgentResultText,
  normalizeHookPayload,
  type HookListenerState
} from './agent-hook-listener'
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
})
