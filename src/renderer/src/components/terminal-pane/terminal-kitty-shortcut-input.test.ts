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

    expect(settlement.dispatch(SHIFT_ENTER, 0, send)).toBe(true)
    expect(send).not.toHaveBeenCalled()

    settlement.settle(1)

    expect(send).toHaveBeenCalledExactlyOnceWith('\x1b[13;2u')
  })

  it('preserves the legacy encoding after a non-Kitty reattach settles', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()

    settlement.dispatch(SHIFT_ENTER, 0, send)
    settlement.settle(0)

    expect(send).toHaveBeenCalledExactlyOnceWith('\x1b\r')
  })

  it('re-enters settlement when an already-bound pane starts another reattach', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()
    settlement.settle(1)

    settlement.dispatch(SHIFT_ENTER, 1, send)
    settlement.begin()
    settlement.dispatch(SHIFT_ENTER, 1, send)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith('\x1b[13;2u')

    settlement.settle(0)

    expect(send).toHaveBeenNthCalledWith(2, '\x1b\r')
  })

  it('uses current proven Kitty state after the attach has settled', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()
    settlement.settle(0)

    settlement.dispatch(SHIFT_ENTER, 1, send)

    expect(send).toHaveBeenCalledExactlyOnceWith('\x1b[13;2u')
  })

  it('delivers queued input through the replacement transport sender', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const oldSend = vi.fn()
    const replacementSend = vi.fn()
    let currentSend = oldSend

    settlement.dispatch(SHIFT_ENTER, 0, (data) => currentSend(data))
    currentSend = replacementSend
    settlement.settle(1)

    expect(oldSend).not.toHaveBeenCalled()
    expect(replacementSend).toHaveBeenCalledExactlyOnceWith('\x1b[13;2u')
  })

  it('drops deferred input when the pane is disposed', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()

    settlement.dispatch(SHIFT_ENTER, 0, send)
    settlement.dispose()
    settlement.settle(1)

    expect(send).not.toHaveBeenCalled()
    expect(settlement.dispatch(SHIFT_ENTER, 1, send)).toBe(false)
  })

  it('bounds deferred input while a reattach is stalled', () => {
    const settlement = new TerminalKittyShortcutInputSettlement()
    const send = vi.fn()

    for (let index = 0; index < 64; index += 1) {
      expect(settlement.dispatch(SHIFT_ENTER, 0, send)).toBe(true)
    }
    settlement.settle(1)

    expect(send).toHaveBeenCalledTimes(32)
  })
})
