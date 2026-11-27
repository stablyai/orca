import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  createTerminalPixelSizeQueryResponder,
  rescalePixelMouseReport
} from './terminal-capability-replies'

describe('rescalePixelMouseReport', () => {
  // Real xterm: the rescale reads xterm's private mouse encoding, so an upgrade that moves it fails here.
  it('lands every pixel on its drawn cell using the size the app was last told', async () => {
    const terminal = new Terminal({ cols: 120, rows: 38, allowProposedApi: true })
    let screen = { width: 1234.5, height: 581 }
    const screenElement = { getBoundingClientRect: () => screen }
    Object.defineProperty(terminal, 'element', { value: { querySelector: () => screenElement } })
    await new Promise<void>((resolve) => terminal.write('\x1b[?1016h', resolve))
    const replies: string[] = []
    createTerminalPixelSizeQueryResponder(terminal, (reply) => void replies.push(reply))('\x1b[16t')
    expect(replies).toEqual(['\x1b[6;15;10t'])

    const misplaced = (): string[] => {
      const wrong: string[] = []
      for (let px = 0; px < Math.max(screen.width, screen.height); px++) {
        const [, x, y] = rescalePixelMouseReport(terminal, `\x1b[<0;${px};${px}M`)
          .slice(3, -1)
          .split(';')
          .map(Number)
        const drawn = [Math.floor(px / (screen.width / 120)), Math.floor(px / (screen.height / 38))]
        // The app converts with the 10 x 15 reply until it asks again.
        if (px < screen.width && Math.floor(x / 10) !== drawn[0]) {
          wrong.push(`x=${px}`)
        }
        if (px < screen.height && Math.floor(y / 15) !== drawn[1]) {
          wrong.push(`y=${px}`)
        }
      }
      return wrong
    }
    expect(misplaced()).toEqual([])
    screen = { width: 120 * 8.362, height: 38 * 18.268 }
    expect(misplaced()).toEqual([])
    expect(rescalePixelMouseReport(terminal, 'a')).toBe('a')
    terminal.dispose()
  })
})
