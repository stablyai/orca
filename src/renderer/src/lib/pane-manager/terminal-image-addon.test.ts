import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { createTerminalImageAddon } from './terminal-image-addon'

describe('createTerminalImageAddon', () => {
  it('leaves window size reports to the terminal host', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const onData = vi.fn()
    term.onData(onData)
    term.loadAddon(createTerminalImageAddon() as never)
    try {
      // Why: Orca answers CSI 14t/16t through its own gated responder; a second
      // reply from the addon would reach the shell as stray input.
      const { promise, resolve } = Promise.withResolvers<void>()
      term.write('\x1b[14t\x1b[16t\x1b[18t', resolve)
      await promise
      expect(onData).not.toHaveBeenCalled()
    } finally {
      term.dispose()
    }
  })
})
