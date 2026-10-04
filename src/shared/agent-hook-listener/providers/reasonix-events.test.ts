import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept } from '../../agent-hook-listener-test-harness'
import { extractAgentProviderSession, getAgentResumeArgv } from '../../agent-session-resume'

const capture = z
  .object({ events: z.array(z.record(z.string(), z.unknown())) })
  .parse(
    JSON.parse(
      readFileSync(
        join(__dirname, '__fixtures__/reasonix-1-39-7-native-auth-rejection.hooks.json'),
        'utf8'
      )
    )
  )
const id = '985b66b859ffae5cd8d17ef63ec3d33c'
function event(name: string, fields: Record<string, unknown> = {}) {
  return { event: name, sessionId: id, cwd: '/workspace', ...fields }
}

describe('stable native Reasonix hooks', () => {
  let state: HookListenerState
  beforeEach(() => {
    state = createHookListenerState()
  })

  it('normalizes fresh native auth-error capture without inventing a successful assistant turn', () => {
    const rows = capture.events.map((payload) => normalizeAndAccept(state, 'reasonix', payload))
    expect(rows.map((row) => row?.hookEventName)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'StopFailure',
      'Stop',
      'SessionEnd'
    ])
    expect(rows[0]?.payload).toMatchObject({ state: 'done', sessionBoundary: true })
    expect(rows[1]).toMatchObject({
      hasExplicitPrompt: true,
      providerPromptId: `${id}:1`,
      promptInteractionKey: `reasonix-${id}-1`,
      payload: { state: 'working' }
    })
    expect(rows[2]?.payload.mainAgent?.outcome).toBe('failure')
    expect(rows[3]?.payload.mainAgent).toEqual(rows[2]?.payload.mainAgent)
    expect(rows[4]?.payload.mainAgent).toEqual(rows[3]?.payload.mainAgent)
    expect(rows.every((row) => row?.providerSession?.id === id)).toBe(true)
    expect(rows.some((row) => row?.payload.mainAgent?.outcome === 'success')).toBe(false)
    const providerSession = rows[1]?.providerSession
    if (!providerSession) {
      throw new Error('Captured native prompt has no provider session')
    }
    expect(getAgentResumeArgv('reasonix', providerSession)).toEqual(['reasonix', '--resume', id])
  })

  it('rejects stale Stop and same-turn working events after settlement', () => {
    normalizeAndAccept(state, 'reasonix', event('UserPromptSubmit', { prompt: 'first', turn: 1 }))
    normalizeAndAccept(state, 'reasonix', event('UserPromptSubmit', { prompt: 'next', turn: 2 }))
    expect(
      normalizeAndAccept(state, 'reasonix', event('StopFailure', { turn: 1, error: 'stale' }))
    ).toBeNull()
    normalizeAndAccept(state, 'reasonix', event('Stop', { turn: 2 }))
    expect(
      normalizeAndAccept(state, 'reasonix', event('PostToolUse', { turn: 2, toolName: 'read' }))
    ).toBeNull()
    expect(
      normalizeAndAccept(state, 'reasonix', event('UserPromptSubmit', { prompt: 'new', turn: 3 }))
        ?.payload.state
    ).toBe('working')
  })

  it('uses the source-native ask schema without changing other providers or synthesizing an answer', () => {
    normalizeAndAccept(state, 'reasonix', event('UserPromptSubmit', { prompt: 'choose', turn: 1 }))
    const toolArgs = {
      questions: [
        { header: 'Choice', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }
      ]
    }
    const waiting = normalizeAndAccept(
      state,
      'reasonix',
      event('PreToolUse', { turn: 1, toolName: 'ask', toolArgs })
    )
    expect(waiting?.payload).toMatchObject({
      state: 'waiting',
      toolName: 'ask',
      interactivePrompt: JSON.stringify(toolArgs)
    })
    const answered = normalizeAndAccept(
      state,
      'reasonix',
      event('PostToolUse', { turn: 1, toolName: 'ask', toolArgs, toolResult: 'A' })
    )
    expect(answered?.payload.state).toBe('working')
    expect(answered?.payload.interactivePrompt).toBeUndefined()
    expect(
      normalizeAndAccept(
        state,
        'reasonix',
        event('SessionStart', { sessionId: 'new-id', source: 'startup' })
      )?.providerSession?.id
    ).toBe('new-id')
  })

  it('retains the working clock and distinguishes interrupt from ordinary Stop', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200).mockReturnValueOnce(300)
    const prompt = normalizeAndAccept(
      state,
      'reasonix',
      event('UserPromptSubmit', { prompt: 'read', turn: 1 })
    )
    const tool = normalizeAndAccept(
      state,
      'reasonix',
      event('PreToolUse', { toolName: 'read', toolArgs: { path: 'README.md' }, turn: 1 })
    )
    expect(tool?.payload.mainAgent?.stateStartedAt).toBe(prompt?.payload.mainAgent?.stateStartedAt)
    expect(tool?.payload.toolName).toBe('read')
    expect(
      normalizeAndAccept(
        state,
        'reasonix',
        event('StopFailure', { turn: 1, isInterrupt: true, error: 'context canceled' })
      )?.payload
    ).toMatchObject({ interrupted: true, mainAgent: { outcome: 'cancellation' } })
    vi.restoreAllMocks()
  })

  it('keeps child or unrelated session events out of the lead row', () => {
    normalizeAndAccept(state, 'reasonix', event('UserPromptSubmit', { prompt: 'lead', turn: 1 }))
    for (const name of ['SubagentStart', 'SubagentStop', 'Stop', 'UserPromptSubmit']) {
      expect(
        normalizeAndAccept(
          state,
          'reasonix',
          event(name, { sessionId: 'child', prompt: 'child', turn: 1 })
        )
      ).toBeNull()
    }
    expect(
      normalizeAndAccept(
        state,
        'reasonix',
        event('SessionStart', { sessionId: 'next', source: 'clear' })
      )?.providerSession?.id
    ).toBe('next')
  })

  it('uses native sessionId and refuses missing or unsafe identities', () => {
    expect(extractAgentProviderSession('reasonix', { session_id: id })).toBeNull()
    for (const sessionId of ['../id', '--continue', 'CON', 'bad\nid']) {
      expect(
        normalizeAndAccept(
          state,
          'reasonix',
          event('UserPromptSubmit', { sessionId, prompt: 'unsafe' })
        )
      ).toBeNull()
      expect(getAgentResumeArgv('reasonix', { key: 'session_id', id: sessionId })).toBeNull()
    }
    expect(getAgentResumeArgv('reasonix', { key: 'conversation_id', id })).toBeNull()
  })

  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'refuses a turn event without the native positive integer turn %j',
    (turn) => {
      expect(
        normalizeAndAccept(state, 'reasonix', event('UserPromptSubmit', { prompt: 'bad', turn }))
      ).toBeNull()
    }
  )
})
