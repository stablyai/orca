import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { createTerminalPixelSizeQueryResponder } from './terminal-capability-replies'
import { subscribeToTerminalPtyInputData } from './terminal-pty-input-data'

// Runs against the real vendored @xterm/xterm build on purpose: the rescale reads xterm's
// private mouse encoding, so an upgrade that moves it must fail here rather than send raw px.
describe('subscribeToTerminalPtyInputData', () => {
  it('delivers real xterm pixel mouse reports on the replied cell grid', async () => {
    const terminal = new Terminal({ cols: 80, rows: 41, allowProposedApi: true })
    // An 80x41 screen of 8.362 x 18.268 px cells, answered as 8 x 18.
    const screen = { getBoundingClientRect: () => ({ width: 80 * 8.362, height: 41 * 18.268 }) }
    Object.defineProperty(terminal, 'element', { value: { querySelector: () => screen } })
    await new Promise<void>((resolve) => terminal.write('\x1b[?1003h\x1b[?1016h', resolve))
    createTerminalPixelSizeQueryResponder(terminal, () => true)('\x1b[16t')
    const listener = vi.fn()
    const subscription = subscribeToTerminalPtyInputData(terminal, listener)

    terminal.input('\x1b[<0;79;630M', true)
    terminal.input('a', true)

    expect(listener.mock.calls).toEqual([
      ['\x1b[<0;75;620M', true],
      ['a', true]
    ])
    subscription.dispose()
    terminal.dispose()
  })
})
