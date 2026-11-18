import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeAndAccept } from '../../normalization/agent-hook-listener-test-harness'

// Kimi Code 2.6.3 payloads captured from a real Esc cancel.
const envelope = {
  session_id: 'session_44329939-0bb6-49a3-bd51-aba81e98e673',
  cwd: '/tmp/ws',
  client_type: 'kimi_code_cli',
  session_title: 'Reply with one word: ok'
}

describe('Kimi hook events', () => {
  it('settles a cancelled turn as interrupted on Interrupt, which Kimi sends instead of Stop', () => {
    const state = createHookListenerState()
    normalizeAndAccept(state, 'kimi', {
      ...envelope,
      hook_event_name: 'UserPromptSubmit',
      prompt: [{ type: 'text', text: 'Reply with one word: ok' }],
      is_steer: false
    })

    expect(
      normalizeAndAccept(state, 'kimi', {
        ...envelope,
        hook_event_name: 'Interrupt',
        turn_id: 0,
        reason: 'cancelled'
      })?.payload
    ).toMatchObject({ state: 'done', interrupted: true, prompt: 'Reply with one word: ok' })
  })
})
