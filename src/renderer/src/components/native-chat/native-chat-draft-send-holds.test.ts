// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createNativeChatDraftSendHolds } from './native-chat-draft-send-holds'

const HOLD = { saveAtOnce: false }

describe('send holds', () => {
  it("skips an earlier send's save while a later one waits, never the other way round", () => {
    const persist = vi.fn()
    const holds = createNativeChatDraftSendHolds(persist)
    const first = holds.clearForSend('chat', () => {}, HOLD)
    const second = holds.clearForSend('chat', () => {}, HOLD)

    first()
    expect(persist).not.toHaveBeenCalled()
    second()
    expect(persist).toHaveBeenCalledOnce()
  })

  // Until the agent accepted it, the host may lose a message when Orca quits.
  it('keeps a hold when the window goes away', () => {
    const persist = vi.fn()
    const holds = createNativeChatDraftSendHolds(persist)
    holds.clearForSend('structured', () => {}, HOLD)

    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('beforeunload'))

    expect(persist).not.toHaveBeenCalled()
  })

  // Chat discards forget its sends; nothing else would, for one that never lands.
  it("forgets an ended chat's sends", () => {
    const holds = createNativeChatDraftSendHolds(vi.fn())
    holds.clearForSend('chat', () => {}, HOLD)
    holds.clearForSend('other', () => {}, HOLD)

    holds.forget(['chat'])

    expect(holds.sendsAwaitingForTests('chat')).toBe(0)
    expect(holds.sendsAwaitingForTests('other')).toBe(1)
  })
})
