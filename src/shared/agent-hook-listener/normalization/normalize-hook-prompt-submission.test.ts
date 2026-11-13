import { expect, it } from 'vitest'
import { createHookListenerState } from '../listener-state'
import { normalizeAndAccept } from './agent-hook-listener-test-harness'

it.each(['claude', 'codex'] as const)(
  'retains %s original prompt-submit evidence before preview loss',
  (source) => {
    const state = createHookListenerState()
    const prompt = `exact\n${'x'.repeat(240)}\n trailing `
    const event = normalizeAndAccept(state, source, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'root',
      prompt
    })
    expect(event?.promptSubmissionDigest).toBe(
      '88e79286d1d5639c273f7eca52e5063704100f1113a3d3f7ba6107264e6fd930'
    )
    expect(
      normalizeAndAccept(state, source, { hook_event_name: 'Stop', session_id: 'root' })
        ?.promptSubmissionDigest
    ).toBeUndefined()
  }
)

it('keeps an explicit empty prompt separate from missing or inherited prompt text', () => {
  const state = createHookListenerState()
  expect(
    normalizeAndAccept(state, 'claude', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'root',
      prompt: ''
    })?.promptSubmissionDigest
  ).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(
    normalizeAndAccept(state, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'root' })
      ?.promptSubmissionDigest
  ).toBeUndefined()
})
