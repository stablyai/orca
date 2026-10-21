import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  subscribeToTerminalInputData,
  subscribeToTerminalUserInput
} from './terminal-user-input-signal'

type CoreServiceAccess = {
  _core: {
    coreService: {
      triggerDataEvent: (data: string, wasUserInput?: boolean) => void
    }
  }
}

// These tests run against the real vendored @xterm/xterm build on purpose:
// the subscription reaches a core-internal API, so an xterm upgrade that
// removes or reshapes it must fail here loudly instead of silently dropping
// terminal activity tracking to the onData fallback.
describe('subscribeToTerminalUserInput', () => {
  it('fires for real user input and not for parser auto-replies', () => {
    const terminal = new Terminal({ allowProposedApi: true })
    const listener = vi.fn()
    const subscription = subscribeToTerminalUserInput(terminal, listener)
    expect(subscription).not.toBeNull()

    const coreService = (terminal as unknown as CoreServiceAccess)._core.coreService
    // Keyboard/IME/paste/mouse paths mark their data as user input.
    coreService.triggerDataEvent('a', true)
    expect(listener).toHaveBeenCalledTimes(1)

    // Parser-generated replies (focus reports, DA/DSR/CPR responses) are not
    // user input and must not fire the signal, while still flowing to onData.
    const onData = vi.fn()
    terminal.onData(onData)
    coreService.triggerDataEvent('\x1b[O', false)
    coreService.triggerDataEvent('\x1b[?1;2c')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(onData).toHaveBeenCalledTimes(2)

    subscription?.dispose()
    coreService.triggerDataEvent('b', true)
    expect(listener).toHaveBeenCalledTimes(1)
    terminal.dispose()
  })

  it('returns null when the core signal is unavailable', () => {
    const listener = vi.fn()
    expect(subscribeToTerminalUserInput({} as never, listener)).toBeNull()
    expect(
      subscribeToTerminalUserInput({ _core: { coreService: {} } } as never, listener)
    ).toBeNull()
    expect(
      subscribeToTerminalUserInput(
        {
          _core: {
            coreService: {
              onUserInput: () => {
                throw new Error('unavailable')
              }
            }
          }
        } as never,
        listener
      )
    ).toBeNull()
    // A reshaped internal that subscribes but returns no usable disposable
    // must read as unavailable, so callers keep their onData fallback.
    expect(
      subscribeToTerminalUserInput(
        { _core: { coreService: { onUserInput: () => undefined } } } as never,
        listener
      )
    ).toBeNull()
    expect(
      subscribeToTerminalUserInput(
        { _core: { coreService: { onUserInput: () => ({}) } } } as never,
        listener
      )
    ).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('subscribeToTerminalInputData', () => {
  it('classifies real xterm events independently and disposes both subscriptions', () => {
    const terminal = new Terminal({ allowProposedApi: true })
    const core = (terminal as unknown as CoreServiceAccess)._core.coreService
    const listener = vi.fn()
    const subscription = subscribeToTerminalInputData(terminal, listener)
    core.triggerDataEvent('keyboard', true)
    core.triggerDataEvent('\x1b[?1;2c')
    core.triggerDataEvent('\x1b[200~paste\x1b[201~', true)
    core.triggerDataEvent('\x1b[O', false)
    expect(listener.mock.calls).toEqual([
      ['keyboard', true],
      ['\x1b[?1;2c', false],
      ['\x1b[200~paste\x1b[201~', true],
      ['\x1b[O', false]
    ])
    subscription.dispose()
    core.triggerDataEvent('after-dispose', true)
    expect(listener).toHaveBeenCalledTimes(4)
    terminal.dispose()
  })
})
