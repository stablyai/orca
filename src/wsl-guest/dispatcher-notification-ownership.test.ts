import { describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'

describe('RelayDispatcher notification ownership', () => {
  it('refuses a second handler for a method instead of silently shadowing the first', () => {
    const dispatcher = new RelayDispatcher(() => {})
    const owner = vi.fn()

    dispatcher.onNotification('pty.ackData', owner)

    // Duplicate single-slot handlers must fail rather than let construction order silently disable credit acks.
    expect(() => dispatcher.onNotification('pty.ackData', vi.fn())).toThrow(/already registered/)

    dispatcher.dispose()
  })
})
