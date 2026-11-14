import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { createTerminalPixelSizeQueryResponder } from '../emulation/terminal-capability-replies'
import { subscribeToTerminalPtyInputData } from './terminal-pty-input-data'

// Real @xterm/xterm on purpose: the rescale reads xterm's private mouse encoding, so an
// upgrade that moves it must fail here rather than send raw px.
describe('subscribeToTerminalPtyInputData', () => {
  it('delivers pixel mouse reports on the cell grid the app was told', async () => {
    const terminal = new Terminal({ cols: 80, rows: 41, allowProposedApi: true })
    // Measured at UI zoom 1.5 on a Retina display: 8.362 x 18.268 px cells.
    let cell = { width: 8.362, height: 18.268 }
    const screen = {
      getBoundingClientRect: () => ({ width: 80 * cell.width, height: 41 * cell.height })
    }
    Object.defineProperty(terminal, 'element', { value: { querySelector: () => screen } })
    await new Promise<void>((resolve) => terminal.write('\x1b[?1003h\x1b[?1016h', resolve))
    const replies: string[] = []
    const observeOutput = createTerminalPixelSizeQueryResponder(terminal, (data) => {
      replies.push(data)
    })
    const received: string[] = []
    const subscription = subscribeToTerminalPtyInputData(terminal, (data) => received.push(data))

    observeOutput('\x1b[16t')
    // Row 35, column 10 as drawn; unscaled, 630 / 18 reads as row 36.
    terminal.input('\x1b[<0;79;630M', true)
    terminal.input('a', true)
    // The cell changes, but the app keeps converting with 8 x 18 until it asks again.
    cell = { width: 8.504, height: 18 }
    terminal.input('\x1b[<0;80;621M', true)
    observeOutput('\x1b[16t')
    terminal.input('\x1b[<0;80;621M', true)

    expect(replies).toEqual(['\x1b[6;18;8t', '\x1b[6;18;9t'])
    expect(received).toEqual(['\x1b[<0;75;620M', 'a', '\x1b[<0;75;621M', '\x1b[<0;84;621M'])
    subscription.dispose()
    terminal.dispose()
  })
})
