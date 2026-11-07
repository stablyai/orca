import { describe, expect, it } from 'vitest'

import { nativeChatComposerSendState } from './native-chat-composer-send-state'

function chordSteersQueued(
  overrides: Partial<Parameters<typeof nativeChatComposerSendState>[0]> & {
    followUp?: 'queue' | 'steer'
  } = {}
): boolean {
  const { followUp = 'queue', ...input } = overrides
  const working = input.isWorking ?? false
  const structuredTransport = {
    optionSnapshot: [],
    sendFollowUp: { action: followUp, offersChoice: working }
  }
  return nativeChatComposerSendState({
    agent: 'claude',
    draft: '',
    messageDelivery: true,
    imageAttachments: [],
    pastedTextSaving: false,
    disabled: false,
    structuredTransport,
    editSession: undefined,
    isWorking: false,
    canStop: true,
    ...input
  }).chordSteersQueued
}

describe('nativeChatComposerSendState chordSteersQueued', () => {
  it('sends the head card from an empty composer where steering means sending it now', () => {
    // No turn runs (a paused queue after Stop): the card's own Send.
    expect(chordSteersQueued()).toBe(true)
    // Mid-turn with follow-ups queued: the chord's other way is a steer.
    expect(chordSteersQueued({ isWorking: true })).toBe(true)
  })

  it.each([
    ['the chord queues mid-turn', { isWorking: true, followUp: 'steer' as const }],
    ['a queued card is being edited', { editSession: { canSave: true } }],
    ['the composer submits a goal, not a message', { messageDelivery: false }]
  ])('never does where %s', (_case, overrides) => {
    expect(chordSteersQueued(overrides)).toBe(false)
  })
})
