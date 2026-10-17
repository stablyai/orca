import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  CONPTY_DA1_RESPONSE,
  DEFAULT_DA1_RESPONSE,
  createTerminalPixelSizeQueryResponder,
  installTerminalCapabilityReplyHandlers,
  rescalePixelMouseReport,
  sendTerminalOscColorQueryReplies,
  withSixelDa1Attribute
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

  it('advertises Sixel in DA1 while inline images are enabled', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false,
      sixelSupported: () => true
    })

    try {
      await writeTerminal(term, '\x1b[c')

      expect(sendInput).toHaveBeenCalledWith('\x1b[?1;2;4c')
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('omits Sixel from DA1 when inline images are disabled', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false,
      sixelSupported: () => false
    })

    try {
      await writeTerminal(term, '\x1b[c')

      expect(sendInput).toHaveBeenCalledWith(DEFAULT_DA1_RESPONSE)
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('reflects a live inline-images toggle on the next DA1 query', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    let enabled = false
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false,
      sixelSupported: () => enabled
    })

    try {
      await writeTerminal(term, '\x1b[c')
      expect(sendInput).toHaveBeenLastCalledWith(DEFAULT_DA1_RESPONSE)

      enabled = true
      await writeTerminal(term, '\x1b[c')
      expect(sendInput).toHaveBeenLastCalledWith('\x1b[?1;2;4c')
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('does not double-add Sixel to a ConPTY DA1 response that already lists it', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput,
      isReplaying: () => false,
      da1Response: CONPTY_DA1_RESPONSE,
      sixelSupported: () => true
    })

    try {
      await writeTerminal(term, '\x1b[c')

      expect(sendInput).toHaveBeenCalledWith(CONPTY_DA1_RESPONSE)
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('withSixelDa1Attribute inserts and dedupes the Sixel capability', () => {
    expect(withSixelDa1Attribute('\x1b[?1;2c')).toBe('\x1b[?1;2;4c')
    expect(withSixelDa1Attribute('\x1b[?61;4c')).toBe('\x1b[?61;4c')
    expect(withSixelDa1Attribute('\x1b[?62;4;9;22c')).toBe('\x1b[?62;4;9;22c')
    // Leaves anything that is not a DA1 response untouched.
    expect(withSixelDa1Attribute('\x1b[0m')).toBe('\x1b[0m')
  })

  it('does not answer OSC color queries when the pane skips them (jcode)', async () => {
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
      isReplaying: () => false,
      skipOscColorQueryReplies: () => true
    })

    try {
      await writeTerminal(term, '\x1b]10;?\x1b\\\x1b]11;?\x1b\\')

      expect(sendInput).not.toHaveBeenCalled()
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

  it.each([
    ['OSC 11 then CPR', '\x1b]11;?\x1b\\\x1b[6n', ['osc', 'cpr']],
    ['CPR then OSC 11', '\x1b[6n\x1b]11;?\x1b\\', ['cpr', 'osc']]
  ] as const)('preserves combined query order (%s)', async (_name, input, expectedKinds) => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.options.theme = { background: '#ffffff' }
    const replies: string[] = []
    const disposable = installTerminalCapabilityReplyHandlers({
      terminal: term as never,
      parser: term.parser,
      sendInput: (data) => {
        replies.push(data)
      },
      isReplaying: () => false
    })
    const onData = term.onData((data) => replies.push(data))

    try {
      await writeTerminal(term, input)
      const kinds = replies.map((reply) => (reply.startsWith('\x1b]11;') ? 'osc' : 'cpr'))
      expect(kinds).toEqual(expectedKinds)
    } finally {
      onData.dispose()
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

  it('answers combined OSC foreground and background color queries from the active theme', async () => {
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
      await writeTerminal(term, '\x1b]10;?;?\x1b\\')

      expect(sendInput).toHaveBeenCalledWith('\x1b]10;rgb:2e2e/3434/3434\x1b\\')
      expect(sendInput).toHaveBeenCalledWith('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    } finally {
      disposable.dispose()
      term.dispose()
    }
  })

  it('answers extracted OSC color queries without waiting for xterm parsing', () => {
    const sendInput = vi.fn<(data: string) => boolean>(() => true)

    const sent = sendTerminalOscColorQueryReplies(
      '\x1b]10;?\x1b\\ordinary text\x1b]11;?\x07',
      {
        options: {
          theme: {
            foreground: '#2e3434',
            background: '#ffffff'
          }
        }
      } as never,
      sendInput
    )

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('\x1b]10;rgb:2e2e/3434/3434\x1b\\')
    expect(sendInput).toHaveBeenCalledWith('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
  })

  it('answers extracted combined OSC foreground and background color queries', () => {
    const sendInput = vi.fn<(data: string) => boolean>(() => true)

    const sent = sendTerminalOscColorQueryReplies(
      '\x1b]10;?;?\x1b\\',
      {
        options: {
          theme: {
            foreground: '#2e3434',
            background: '#ffffff'
          }
        }
      } as never,
      sendInput
    )

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('\x1b]10;rgb:2e2e/3434/3434\x1b\\')
    expect(sendInput).toHaveBeenCalledWith('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
  })

  it('does not answer extracted OSC color commands that only start like queries', () => {
    const sendInput = vi.fn<(data: string) => boolean>(() => true)

    const sent = sendTerminalOscColorQueryReplies(
      '\x1b]10;?not-a-query\x1b\\ordinary text\x1b]11;?still-not-a-query\x07\x1b]10;?;?;?\x1b\\',
      {
        options: {
          theme: {
            foreground: '#2e3434',
            background: '#ffffff'
          }
        }
      } as never,
      sendInput
    )

    expect(sent).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
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

describe('rescalePixelMouseReport', () => {
  // Measured on a MacBook Retina display (devicePixelRatio 2, 2.63 at UI zoom 1.5), D2Coding 17.
  const ZOOM_15 = { cols: 80, rows: 41, screenWidth: 80 * 8.362, screenHeight: 41 * 18.268 }
  const ZOOM_0 = { cols: 127, rows: 56, screenWidth: 127 * 8.504, screenHeight: 56 * 18 }

  function createPixelMouseTerminal(
    geometry: typeof ZOOM_15,
    activeEncoding = 'SGR_PIXELS'
  ): {
    cols: number
    rows: number
    element: HTMLElement
    _core: { mouseStateService: { activeEncoding: string } }
  } {
    return {
      cols: geometry.cols,
      rows: geometry.rows,
      element: createElement(geometry.screenWidth, geometry.screenHeight),
      _core: { mouseStateService: { activeEncoding } }
    }
  }

  // The cell an app computes from a pixel report, given the cell size it was told (1-based).
  function cellFromPixelReport(report: string, cellWidth: number, cellHeight: number): number[] {
    const [, x, y] = report.slice(3, -1).split(';').map(Number)
    return [Math.floor(y / cellHeight) + 1, Math.floor(x / cellWidth) + 1]
  }

  it('maps the reported zoom 1.5 clicks back onto the rows and columns that were clicked', () => {
    const terminal = createPixelMouseTerminal(ZOOM_15)
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    createTerminalPixelSizeQueryResponder(terminal, sendInput)('\x1b[16t')
    expect(sendInput).toHaveBeenCalledWith('\x1b[6;18;8t')

    // Row 35, column 10: unscaled, 630 / 18 reads as row 36.
    expect(rescalePixelMouseReport(terminal, '\x1b[<0;79;630M')).toBe('\x1b[<0;75;620M')
    expect(cellFromPixelReport('\x1b[<0;75;620M', 8, 18)).toEqual([35, 10])
    // Row 40, column 70: unscaled, it reads as row 41, column 73.
    expect(rescalePixelMouseReport(terminal, '\x1b[<0;580;721M')).toBe('\x1b[<0;554;710M')
    expect(cellFromPixelReport('\x1b[<0;554;710M', 8, 18)).toEqual([40, 70])
  })

  it.each([
    { zoom: '1.5', geometry: ZOOM_15, cellWidth: 8, cellHeight: 18 },
    { zoom: '0', geometry: ZOOM_0, cellWidth: 9, cellHeight: 18 }
  ])(
    'lands every pixel on the cell it was drawn in at UI zoom $zoom',
    ({ geometry, cellWidth, cellHeight }) => {
      const terminal = createPixelMouseTerminal(geometry)
      createTerminalPixelSizeQueryResponder(terminal, () => true)('\x1b[16t')
      const cssCellWidth = geometry.screenWidth / geometry.cols
      const cssCellHeight = geometry.screenHeight / geometry.rows

      // xterm floors the pointer offset and clamps it to the last pixel of the screen.
      for (let x = 0; x <= geometry.screenWidth - 1; x++) {
        const report = rescalePixelMouseReport(terminal, `\x1b[<0;${x};0M`)
        expect(cellFromPixelReport(report, cellWidth, cellHeight)[1]).toBe(
          Math.floor(x / cssCellWidth) + 1
        )
      }
      for (let y = 0; y <= geometry.screenHeight - 1; y++) {
        const report = rescalePixelMouseReport(terminal, `\x1b[<0;0;${y}M`)
        expect(cellFromPixelReport(report, cellWidth, cellHeight)[0]).toBe(
          Math.floor(y / cssCellHeight) + 1
        )
      }
    }
  )

  it('leaves reports alone when the cell is already a whole number of px', () => {
    // e.g. 100% display scaling: 9 x 22 px cells are replied as 9 x 22.
    const terminal = createPixelMouseTerminal({
      cols: 80,
      rows: 24,
      screenWidth: 80 * 9,
      screenHeight: 24 * 22
    })
    createTerminalPixelSizeQueryResponder(terminal, () => true)('\x1b[16t')

    for (let x = 0; x < 80 * 9; x++) {
      expect(rescalePixelMouseReport(terminal, `\x1b[<0;${x};15M`)).toBe(`\x1b[<0;${x};15M`)
    }
    for (let y = 0; y < 24 * 22; y++) {
      expect(rescalePixelMouseReport(terminal, `\x1b[<0;15;${y}M`)).toBe(`\x1b[<0;15;${y}M`)
    }
  })

  it('keeps the button code and the press or release final byte', () => {
    const terminal = createPixelMouseTerminal(ZOOM_15)
    createTerminalPixelSizeQueryResponder(terminal, () => true)('\x1b[14t')

    expect(rescalePixelMouseReport(terminal, '\x1b[<32;79;630M')).toBe('\x1b[<32;75;620M')
    expect(rescalePixelMouseReport(terminal, '\x1b[<0;79;630m')).toBe('\x1b[<0;75;620m')
    expect(rescalePixelMouseReport(terminal, '\x1b[<65;79;630M')).toBe('\x1b[<65;75;620M')
  })

  it('keeps using the size the app was told until it asks again', () => {
    const terminal = createPixelMouseTerminal(ZOOM_0)
    const observe = createTerminalPixelSizeQueryResponder(terminal, () => true)
    observe('\x1b[16t')
    // The cell becomes 8.362 x 18.268 px; the app still converts with 9 x 18.
    terminal.element = createElement(ZOOM_0.cols * 8.362, ZOOM_0.rows * 18.268)

    expect(
      cellFromPixelReport(rescalePixelMouseReport(terminal, '\x1b[<0;79;630M'), 9, 18)
    ).toEqual([35, 10])

    observe('\x1b[16t')
    expect(
      cellFromPixelReport(rescalePixelMouseReport(terminal, '\x1b[<0;79;630M'), 8, 18)
    ).toEqual([35, 10])
  })

  it('uses the size it would answer now when this terminal was never asked', () => {
    // A remounted pane's app was answered by the xterm this one replaced.
    const remounted = createPixelMouseTerminal(ZOOM_15)
    expect(rescalePixelMouseReport(remounted, '\x1b[<0;79;630M')).toBe('\x1b[<0;75;620M')
  })

  it('ignores a cell size reply that never reached the app', () => {
    const terminal = createPixelMouseTerminal(ZOOM_0)
    const sendInput = vi.fn<(data: string) => boolean>()
    sendInput.mockReturnValueOnce(true).mockReturnValueOnce(false)
    const observe = createTerminalPixelSizeQueryResponder(terminal, sendInput)
    observe('\x1b[16t')
    terminal.element = createElement(ZOOM_0.cols * 8.362, ZOOM_0.rows * 18.268)
    observe('\x1b[16t')

    expect(
      cellFromPixelReport(rescalePixelMouseReport(terminal, '\x1b[<0;79;630M'), 9, 18)
    ).toEqual([35, 10])
  })

  it('leaves cell reports and other input alone', () => {
    const cellMode = createPixelMouseTerminal(ZOOM_15, 'SGR')
    createTerminalPixelSizeQueryResponder(cellMode, () => true)('\x1b[16t')
    expect(rescalePixelMouseReport(cellMode, '\x1b[<0;10;35M')).toBe('\x1b[<0;10;35M')

    const pixelMode = createPixelMouseTerminal(ZOOM_15)
    createTerminalPixelSizeQueryResponder(pixelMode, () => true)('\x1b[16t')
    expect(rescalePixelMouseReport(pixelMode, 'a')).toBe('a')
    expect(rescalePixelMouseReport(pixelMode, '\x1b[A')).toBe('\x1b[A')
    expect(rescalePixelMouseReport(pixelMode, '\x1b[<0;79;630Mx')).toBe('\x1b[<0;79;630Mx')
  })
})
