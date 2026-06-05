import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  CONPTY_DA1_RESPONSE,
  installConptyDeviceAttributesHandler
} from './terminal-conpty-device-attributes'

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

describe('installConptyDeviceAttributesHandler', () => {
  it('answers primary DA1 with the ConPTY basic conformance response', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installConptyDeviceAttributesHandler({
      parser: term.parser,
      sendInput,
      isReplaying: () => false
    })

    try {
      await writeTerminal(term, '\x1b[c')

      expect(sendInput).toHaveBeenCalledTimes(1)
      expect(sendInput).toHaveBeenCalledWith(CONPTY_DA1_RESPONSE)
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('consumes replayed primary DA1 without sending input to the shell', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installConptyDeviceAttributesHandler({
      parser: term.parser,
      sendInput,
      isReplaying: () => true
    })

    try {
      await writeTerminal(term, '\x1b[0c')

      expect(sendInput).not.toHaveBeenCalled()
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('leaves non-primary DA queries to other handlers', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const returnValues: boolean[] = []
    const disposable = installConptyDeviceAttributesHandler({
      parser: {
        registerCsiHandler: (id, cb) =>
          term.parser.registerCsiHandler(id, (params) => {
            const value = cb(params) as boolean
            returnValues.push(value)
            return value
          })
      },
      sendInput,
      isReplaying: () => false
    })

    try {
      await writeTerminal(term, '\x1b[1c')

      expect(sendInput).not.toHaveBeenCalled()
      expect(returnValues).toEqual([false])
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })
})
