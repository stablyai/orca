import { describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'

describe('RelayDispatcher notification ownership', () => {
  it('refuses a second handler for a method instead of silently shadowing the first', () => {
    const dispatcher = new RelayDispatcher(() => {})
    const owner = vi.fn()

    dispatcher.onNotification('pty.ackData', owner)

    // Why: the slot holds one handler, so a second registration used to win purely by
    // construction order — that is how a no-op ack handler nearly disabled credit acks.
    expect(() => dispatcher.onNotification('pty.ackData', vi.fn())).toThrow(/already registered/)

    // Why: the constructor arms a keepalive interval that would outlive the test.
    dispatcher.dispose()
  })
})
