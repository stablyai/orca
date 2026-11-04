import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './normalize-hook-payload'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

const capturedHooks = readFileSync(
  join(__dirname, '../../__fixtures__', 'grok-background-completion-hooks.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map(parseCapturedHook)

function parseCapturedHook(line: string): Record<string, unknown> {
  // JSON.parse returns any; the runtime guard below is what actually proves the shape.
  const parsed: Record<string, unknown> = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Captured Grok hook must be an object')
  }
  return parsed
}

function capturedHook(predicate: (payload: Record<string, unknown>) => boolean) {
  const hook = capturedHooks.find(predicate)
  if (!hook) {
    throw new Error('Captured Grok hook not found')
  }
  return hook
}

describe('Grok completion observations', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function normalize(payload: Record<string, unknown>) {
    return normalizeHookPayload(state, 'grok', { paneKey: PANE_KEY, payload }, 'production')
      ?.payload
  }

  it('keeps the captured pane working until the finite task follow-up settles', () => {
    const lead = normalize(
      capturedHook(
        (hook) =>
          hook.hookEventName === 'stop' && hook.promptId === '8e3fbed9-8839-49a3-8078-0fc261228383'
      )
    )
    const followUp = normalize(
      capturedHook(
        (hook) =>
          hook.hookEventName === 'stop' && String(hook.promptId).startsWith('task-completed-')
      )
    )

    expect(lead).toMatchObject({
      state: 'working',
      workingMode: 'monitoring'
    })
    expect(followUp).toMatchObject({
      state: 'done',
      workingMode: undefined
    })
  })

  it('rejects an identified old turn end after an id-less replacement prompt', () => {
    normalize({
      hookEventName: 'UserPromptSubmit',
      sessionId: 'session-1',
      promptId: 'prompt-old',
      prompt: 'old turn'
    })
    const replacement = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'UserPromptSubmit',
          sessionId: 'session-1',
          promptId: '\u0000invalid',
          prompt: 'new turn'
        }
      },
      'production'
    )
    expect(replacement).toMatchObject({
      grokPromptBoundary: true,
      payload: { state: 'working', prompt: 'new turn' }
    })
    expect(replacement?.providerPromptId).toBeUndefined()

    expect(
      normalize({
        hookEventName: 'StopCancelled',
        sessionId: 'session-1',
        promptId: 'prompt-old',
        reason: 'user_interrupt'
      })
    ).toBeUndefined()
    expect(
      normalize({
        hookEventName: 'Stop',
        sessionId: 'session-1',
        reason: 'end_turn'
      })?.state
    ).toBe('done')
  })
})
