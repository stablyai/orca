import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  CONPTY_DA1_RESPONSE,
  DEFAULT_DA1_RESPONSE,
  createTerminalPixelSizeQueryResponder,
  installTerminalCapabilityReplyHandlers
} from './terminal-capability-replies'

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function createElement(width: number, height: number): HTMLElement {
  return {
    querySelector: () => ({
      getBoundingClientRect: () => ({ width, height })
    })
  } as unknown as HTMLElement
}

describe('installTerminalCapabilityReplyHandlers', () => {
  it('answers primary DA1 with the default xterm-compatible response', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false
    })

    try {
      await writeTerminal(term, '\x1b[c')

      expect(sendInput).toHaveBeenCalledTimes(1)
      expect(sendInput).toHaveBeenCalledWith(DEFAULT_DA1_RESPONSE)
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('keeps the ConPTY basic conformance response override', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false,
      da1Response: CONPTY_DA1_RESPONSE
    })

    try {
      await writeTerminal(term, '\x1b[c')

      expect(sendInput).toHaveBeenCalledWith(CONPTY_DA1_RESPONSE)
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('answers OSC foreground and background color queries from the active theme', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = {
      foreground: '#2e3434',
      background: '#ffffff'
    }
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false
    })

    try {
      await writeTerminal(term, '\x1b]10;?\x1b\\\x1b]11;?\x1b\\')

      expect(sendInput).toHaveBeenCalledWith('\x1b]10;rgb:2e2e/3434/3434\x1b\\')
      expect(sendInput).toHaveBeenCalledWith('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('answers OSC color queries for active rgba and modern rgb theme colors', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = {
      foreground: 'rgb(245 245 244 / 92%)',
      background: 'rgba(17, 34, 51, 0.5)'
    }
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false
    })

    try {
      await writeTerminal(term, '\x1b]10;?\x1b\\\x1b]11;?\x1b\\')

      expect(sendInput).toHaveBeenCalledWith('\x1b]10;rgb:f5f5/f5f5/f4f4\x1b\\')
      expect(sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/2222/3333\x1b\\')
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('leaves non-query OSC color commands to other handlers', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = {
      foreground: '#2e3434',
      background: '#ffffff'
    }
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const returnValues: boolean[] = []
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: {
        registerCsiHandler: (id, cb) =>
          term.parser.registerCsiHandler(id, (params) => cb(params) === true),
        registerOscHandler: (id, cb) =>
          term.parser.registerOscHandler(id, (data) => {
            const value = cb(data) === true
            returnValues.push(value)
            return value
          })
      },
      sendInput,
      isReplaying: () => false
    })

    try {
      await writeTerminal(term, '\x1b]10;#123456\x1b\\')

      expect(sendInput).not.toHaveBeenCalled()
      expect(returnValues).toEqual([false])
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('consumes replayed OSC color queries without sending input to the shell', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = {
      foreground: '#2e3434',
      background: '#ffffff'
    }
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => true
    })

    try {
      await writeTerminal(term, '\x1b]11;?\x1b\\')

      expect(sendInput).not.toHaveBeenCalled()
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('answers window and cell pixel-size reports from renderer geometry', () => {
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const observe = createTerminalPixelSizeQueryResponder(
      {
        cols: 100,
        rows: 40,
        element: createElement(900, 720)
      },
      sendInput
    )

    observe('\x1b[14t\x1b[16t')

    expect(sendInput).toHaveBeenCalledWith('\x1b[4;720;900t')
    expect(sendInput).toHaveBeenCalledWith('\x1b[6;18;9t')
  })

  it('answers split pixel-size reports', () => {
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const observe = createTerminalPixelSizeQueryResponder(
      {
        cols: 100,
        rows: 40,
        element: createElement(900, 720)
      },
      sendInput
    )

    observe('\x1b[')
    observe('16t')

    expect(sendInput).toHaveBeenCalledWith('\x1b[6;18;9t')
  })

  it('consumes replayed capability queries without sending input to the shell', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: { ...term, element: createElement(800, 480) } as never,
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
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: {
        registerCsiHandler: (id, cb) =>
          term.parser.registerCsiHandler(id, (params) => {
            const value = cb(params) === true
            returnValues.push(value)
            return value
          }),
        registerOscHandler: (id, cb) =>
          term.parser.registerOscHandler(id, (data) => cb(data) === true)
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
