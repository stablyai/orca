import { describe, expect, it, vi } from 'vitest'
import { TerminalKittyShortcutInputSettlement } from './terminal-kitty-shortcut-input'

const SHIFT_ENTER = {
  kitty: '\x1b[13;2u',
  legacy: '\x1b\r'
}

describe('TerminalKittyShortcutInputSettlement', () => {
  it('holds Shift+Enter through park reattach until the restored Kitty state is known', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()

    expect(settlement.dispatch(SHIFT_ENTER, send)).toBe(true)
    expect(send).not.toHaveBeenCalled()

    settlement.settle(1)

    expect(send).toHaveBeenCalledExactlyOnceWith('\x1b[13;2u')
  })

  it('preserves the legacy encoding after a non-Kitty reattach settles', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()

    settlement.dispatch(SHIFT_ENTER, send)
    settlement.settle(0)

    expect(send).toHaveBeenCalledExactlyOnceWith('\x1b\r')
  })

  it('re-enters settlement when an already-bound pane starts another reattach', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()
    settlement.settle(1)

    settlement.dispatch(SHIFT_ENTER, send)
    settlement.begin()
    settlement.dispatch(SHIFT_ENTER, send)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith('\x1b[13;2u')

    settlement.settle(0)

    expect(send).toHaveBeenNthCalledWith(2, '\x1b\r')
  })

  it('drops queued input after a failed attach but settles later shortcuts', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()

    settlement.dispatch(SHIFT_ENTER, send)
    settlement.settleDiscardingPending(0)

    expect(send).not.toHaveBeenCalled()
    expect(settlement.dispatch(SHIFT_ENTER, send)).toBe(true)
    expect(send).toHaveBeenCalledExactlyOnceWith('\x1b\r')
  })

  it('drops deferred input when the pane is disposed', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()

    settlement.dispatch(SHIFT_ENTER, send)
    settlement.dispose()
    settlement.settle(1)

    expect(send).not.toHaveBeenCalled()
    expect(settlement.dispatch(SHIFT_ENTER, send)).toBe(false)
  })

  it('bounds deferred input while a reattach is stalled', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()

    for (let index = 0; index < 64; index += 1) {
      expect(settlement.dispatch(SHIFT_ENTER, send)).toBe(true)
    }
    settlement.settle(1)

    expect(send).toHaveBeenCalledTimes(32)
  })
})
