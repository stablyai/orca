import { describe, expect, it } from 'vitest'
import { nativeChatComposerSendState } from './native-chat-composer-send-state'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: send state reads only these fields.
const heldHost = {
  sendBlockedReason: 'Waiting for permission mode',
  threadGoal: { setObjective: async () => true }
} as unknown as NativeChatStructuredComposerTransport

function sendState(draft: string, orcaCommand = false, goalMode = false) {
  return nativeChatComposerSendState({
    draft,
    messageDelivery: true,
    imageAttachments: [],
    pastedTextSaving: false,
    disabled: false,
    structuredTransport: heldHost,
    editSession: undefined,
    isWorking: false,
    canStop: false,
    orcaCommand,
    goalMode
  })
}

function sendDisabled(draft: string, orcaCommand = false, goalMode = false): boolean {
  return sendState(draft, orcaCommand, goalMode).sendButtonDisabled
}

describe('Send on a held chat host', () => {
  it('stays pressable for what Enter still runs and held for anything that starts a turn', () => {
    expect(sendDisabled('/goal pause')).toBe(false)
    expect(sendDisabled('/goal clear')).toBe(false)
    expect(sendDisabled('/model')).toBe(false)
    expect(sendDisabled('/resume', true)).toBe(false)
    expect(sendDisabled('/goal resume')).toBe(true)
    expect(sendDisabled('/goal ship it')).toBe(true)
    expect(sendDisabled('/compact')).toBe(true)
    expect(sendDisabled('hello')).toBe(true)
    // Goal mode sends the draft as an objective, even one spelled like a command.
    expect(sendDisabled('/goal pause', false, true)).toBe(true)
    expect(sendDisabled('/resume', true, true)).toBe(false)
    // An enabled button is not labelled with the hold.
    expect(sendState('/goal pause').sendBlockedReason).toBeNull()
    expect(sendState('hello').sendBlockedReason).toBe('Waiting for permission mode')
  })
})
