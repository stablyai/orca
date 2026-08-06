import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { IMarker, Terminal } from '@xterm/xterm'
import {
  captureScrollState,
  getTerminalOutputEpoch,
  recordTerminalOutput,
  restoreScrollState,
  restoreScrollStateAfterFit,
  restoreScrollStateAfterLayout
} from './pane-scroll'
import type { ScrollState } from './pane-manager-types'

function createTerminal(args: {
  viewportY: number
  baseY: number
  type?: 'normal' | 'alternate'
  cursorY?: number
}): Terminal {
  const active = {
    type: args.type ?? 'normal',
    viewportY: args.viewportY,
    baseY: args.baseY,
    cursorY: args.cursorY ?? 5
  }
  return {
    buffer: { active },
    // Why: restoreScrollStateNow guards on terminal.element to avoid calling
    // scroll APIs after WebGL teardown. Stub a truthy element so these tests
    // exercise the live restore path.
    element: {} as HTMLElement,
    registerMarker: vi.fn((cursorYOffset: number) =>
      createMarker(active.baseY + active.cursorY + cursorYOffset)
    ),
    scrollToBottom: vi.fn(() => {
      active.viewportY = active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      active.viewportY = line
    }),
    scrollLines: vi.fn((delta: number) => {
      active.viewportY = Math.max(0, Math.min(active.baseY, active.viewportY + delta))
    })
  } as unknown as Terminal
}

function createMarker(line: number): IMarker {
  return {
    id: line,
    isDisposed: false,
    line,
    dispose: vi.fn(function (this: { isDisposed: boolean }) {
      this.isDisposed = true
    }),
    onDispose: vi.fn()
  } as unknown as IMarker
}

function setMarkerLine(marker: IMarker, line: number): void {
  const mutableMarker = marker as unknown as { line: number }
  mutableMarker.line = line
}

function writeHeadless(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function findBufferLineContaining(terminal: HeadlessTerminal, text: string): number {
  for (let lineY = 0; lineY < terminal.buffer.active.length; lineY += 1) {
    if (terminal.buffer.active.getLine(lineY)?.translateToString(true).includes(text)) {
      return lineY
    }
  }
  return -1
}

function makeHeadlessRestorable(terminal: HeadlessTerminal): Terminal {
  Object.defineProperty(terminal, 'element', { configurable: true, value: {} })
  return terminal as unknown as Terminal
}

describe('scroll state', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('captures the numeric viewport position', () => {
    const terminal = createTerminal({ viewportY: 42, baseY: 100, cursorY: 7 })

    expect(captureScrollState(terminal)).toMatchObject({
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    })
    expect(terminal.registerMarker).toHaveBeenCalledWith(-65)
  })

  it('tracks output epochs per terminal', () => {
    const terminalA = createTerminal({ viewportY: 0, baseY: 0 })
    const terminalB = createTerminal({ viewportY: 0, baseY: 0 })

    recordTerminalOutput(terminalA)
    recordTerminalOutput(terminalA)
    recordTerminalOutput(terminalB)

    expect(getTerminalOutputEpoch(terminalA)).toBe(2)
    expect(getTerminalOutputEpoch(terminalB)).toBe(1)
  })

  it('restores the captured viewport line', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 100 })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }

    restoreScrollState(terminal, state)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(42)
    expect(terminal.buffer.active.viewportY).toBe(42)
  })

  it('skips restore when the terminal element is gone (post WebGL teardown)', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 100 })
    ;(terminal as unknown as { element: HTMLElement | undefined }).element = undefined
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 100,
      baseY: 100
    }

    restoreScrollState(terminal, state)

    expect(terminal.scrollToBottom).not.toHaveBeenCalled()
    expect(terminal.scrollToLine).not.toHaveBeenCalled()
  })

  it('swallows xterm dimensions errors thrown after a mid-flight WebGL suspend', () => {
    const terminal = createTerminal({ viewportY: 50, baseY: 100 })
    ;(terminal.scrollToBottom as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 100,
      baseY: 100
    }

    expect(() => restoreScrollState(terminal, state)).not.toThrow()
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1)
  })

  it('swallows xterm dimensions errors from scrollToLine on the not-at-bottom branch', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 100 })
    ;(terminal.scrollToLine as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }

    expect(() => restoreScrollState(terminal, state)).not.toThrow()
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(1)
  })

  it('uses the visible line marker when resize reflow changes numeric line positions', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 300 })
    const marker = createMarker(160)
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100,
      firstVisibleLineMarker: marker
    }

    restoreScrollState(terminal, state)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(160)
    expect(terminal.buffer.active.viewportY).toBe(160)
    expect(marker.dispose).toHaveBeenCalledTimes(1)
  })

  it('reapplies a layout restore after xterm settles asynchronously', () => {
    vi.useFakeTimers()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const terminal = createTerminal({ viewportY: 10, baseY: 100 })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }

    restoreScrollStateAfterLayout(terminal, state)
    const activeBuffer = terminal.buffer.active as { viewportY: number }
    activeBuffer.viewportY = 0
    rafCallbacks.shift()?.(0)
    activeBuffer.viewportY = 0
    vi.advanceTimersByTime(80)

    expect(terminal.buffer.active.viewportY).toBe(42)
    expect(terminal.scrollToLine).toHaveBeenCalledWith(42)
  })

  it('keeps the visible line marker alive across deferred layout restores', () => {
    vi.useFakeTimers()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const terminal = createTerminal({ viewportY: 10, baseY: 300 })
    const marker = createMarker(160)
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100,
      firstVisibleLineMarker: marker
    }

    restoreScrollStateAfterLayout(terminal, state)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(160)
    expect(marker.dispose).not.toHaveBeenCalled()

    setMarkerLine(marker, 175)
    const activeBuffer = terminal.buffer.active as { viewportY: number }
    activeBuffer.viewportY = 0
    rafCallbacks.shift()?.(0)
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(175)
    expect(marker.dispose).not.toHaveBeenCalled()

    setMarkerLine(marker, 190)
    activeBuffer.viewportY = 0
    vi.advanceTimersByTime(80)

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(190)
    expect(terminal.buffer.active.viewportY).toBe(190)
    expect(marker.dispose).toHaveBeenCalledTimes(1)
  })

  it('does not run stale animation-frame restores after the timeout restore completes', () => {
    vi.useFakeTimers()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const terminal = createTerminal({ viewportY: 10, baseY: 100 })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }

    restoreScrollStateAfterLayout(terminal, state)
    vi.advanceTimersByTime(80)
    expect(terminal.buffer.active.viewportY).toBe(42)

    const activeBuffer = terminal.buffer.active as { viewportY: number }
    activeBuffer.viewportY = 7
    rafCallbacks.shift()?.(0)

    expect(terminal.buffer.active.viewportY).toBe(7)
  })

  it('clamps the restored viewport line to the current buffer bottom', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 30 })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }

    restoreScrollState(terminal, state)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(30)
    expect(terminal.buffer.active.viewportY).toBe(30)
  })

  it('releases fit markers when restoration throws an unexpected error', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 100 })
    const marker = createMarker(42)
    vi.mocked(terminal.scrollToLine).mockImplementation(() => {
      throw new Error('unexpected renderer failure')
    })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100,
      firstVisibleLineMarker: marker
    }

    expect(() =>
      restoreScrollStateAfterFit(terminal, state, {
        onRestored: vi.fn(),
        shouldRestore: () => true
      })
    ).toThrow('unexpected renderer failure')
    expect(marker.isDisposed).toBe(true)
  })

  it('releases fit markers when an asynchronous retry throws', () => {
    const frameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const terminal = createTerminal({ viewportY: 10, baseY: 100 })
    const marker = createMarker(42)
    vi.mocked(terminal.scrollToLine)
      .mockImplementationOnce(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })
      .mockImplementationOnce(() => {
        throw new Error('unexpected asynchronous renderer failure')
      })

    restoreScrollStateAfterFit(
      terminal,
      {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
        firstVisibleLineMarker: marker
      },
      { onRestored: vi.fn(), shouldRestore: () => true }
    )

    expect(() => frameCallbacks.shift()?.(0)).toThrow('unexpected asynchronous renderer failure')
    expect(marker.isDisposed).toBe(true)
  })

  it('scrolls to the current bottom when the pane was previously at bottom', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 250 })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 100,
      baseY: 100
    }

    restoreScrollState(terminal, state)

    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(terminal.scrollLines).not.toHaveBeenCalled()
    expect(terminal.buffer.active.viewportY).toBe(250)
  })

  it('does not restore across normal and alternate buffers', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 100 })
    const state: ScrollState = {
      bufferType: 'alternate',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }

    restoreScrollState(terminal, state)

    expect(terminal.scrollToLine).not.toHaveBeenCalled()
    expect(terminal.buffer.active.viewportY).toBe(10)
  })

  it.each([
    {
      fromCols: 10,
      toCols: 20,
      pinnedText: 'abcdefghij',
      expectedTop: 'ABCDEFGHIJabcdefghij'
    },
    { fromCols: 20, toCols: 7, pinnedText: 'KLMNOPQRSTuvwxyz', expectedTop: 'efghijK' }
  ])(
    'restores the same logical cells through real xterm reflow ($fromCols->$toCols)',
    async ({ fromCols, toCols, pinnedText, expectedTop }) => {
      const headless = new HeadlessTerminal({
        cols: fromCols,
        rows: 5,
        scrollback: 1000,
        allowProposedApi: true
      })
      try {
        await writeHeadless(headless, 'prefix\r\n')
        await writeHeadless(headless, 'ABCDEFGHIJabcdefghijKLMNOPQRSTuvwxyz\r\n')
        for (let index = 0; index < 10; index += 1) {
          await writeHeadless(headless, `tail-${index}\r\n`)
        }
        const pinnedLine = findBufferLineContaining(headless, pinnedText)
        expect(pinnedLine).toBeGreaterThan(0)
        headless.scrollToLine(pinnedLine)
        const terminal = makeHeadlessRestorable(headless)
        const state = captureScrollState(terminal)

        headless.resize(toCols, 5)
        expect(state.firstVisibleLogicalLineMarker?.isDisposed).toBe(false)
        expect(restoreScrollState(terminal, state)).toBe(true)

        expect(
          headless.buffer.active.getLine(headless.buffer.active.viewportY)?.translateToString(true)
        ).toBe(expectedTop)
      } finally {
        headless.dispose()
      }
    }
  )

  it('uses a logical marker for backend-only ConPTY compatibility', async () => {
    const headless = new HeadlessTerminal({
      cols: 10,
      rows: 5,
      scrollback: 1000,
      allowProposedApi: true,
      windowsPty: { backend: 'conpty' }
    })
    try {
      await writeHeadless(headless, 'prefix\r\n')
      await writeHeadless(headless, 'ABCDEFGHIJabcdefghijKLMNOPQRSTuvwxyz\r\n')
      for (let index = 0; index < 10; index += 1) {
        await writeHeadless(headless, `tail-${index}\r\n`)
      }
      const pinnedLine = findBufferLineContaining(headless, 'abcdefghij')
      headless.scrollToLine(pinnedLine)
      const terminal = makeHeadlessRestorable(headless)
      const state = captureScrollState(terminal)

      expect(state.firstVisibleLogicalLineMarker).toBeDefined()
      headless.resize(20, 5)
      expect(restoreScrollState(terminal, state)).toBe(true)
      expect(
        headless.buffer.active.getLine(headless.buffer.active.viewportY)?.translateToString(true)
      ).toBe('ABCDEFGHIJabcdefghij')
    } finally {
      headless.dispose()
    }
  })

  it('keeps a physical marker for the default non-reflowing cursor line', async () => {
    const headless = new HeadlessTerminal({
      cols: 10,
      rows: 3,
      scrollback: 100,
      allowProposedApi: true
    })
    try {
      await writeHeadless(headless, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
      const terminal = makeHeadlessRestorable(headless)
      headless.scrollLines(-1)
      const state = captureScrollState(terminal)

      expect(state.firstVisibleLineMarker).toBeDefined()
      expect(state.firstVisibleLogicalLineMarker).toBeUndefined()
      headless.resize(20, 3)
      expect(restoreScrollState(terminal, state)).toBe(true)
    } finally {
      headless.dispose()
    }
  })

  it('uses physical markers for legacy ConPTY and logical markers for modern ConPTY', async () => {
    const captureForBuild = async (buildNumber: number): Promise<ScrollState> => {
      const headless = new HeadlessTerminal({
        cols: 10,
        rows: 3,
        scrollback: 100,
        allowProposedApi: true,
        windowsPty: { backend: 'conpty', buildNumber }
      })
      await writeHeadless(headless, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\r\n')
      await writeHeadless(headless, 'tail-1\r\ntail-2\r\ntail-3\r\n')
      const pinnedLine = findBufferLineContaining(headless, 'KLMNOPQRST')
      headless.scrollToLine(pinnedLine)
      const state = captureScrollState(makeHeadlessRestorable(headless))
      headless.dispose()
      return state
    }

    const legacy = await captureForBuild(19045)
    const modern = await captureForBuild(26100)

    expect(legacy.firstVisibleLogicalLineMarker).toBeUndefined()
    expect(modern.firstVisibleLogicalLineMarker).toBeDefined()
  })

  it('counts a wide glyph wrap placeholder as zero logical cells', async () => {
    const headless = new HeadlessTerminal({
      cols: 10,
      rows: 3,
      scrollback: 100,
      allowProposedApi: true
    })
    try {
      await writeHeadless(headless, '123456789界abcdefghij\r\ntail-1\r\ntail-2\r\ntail-3\r\n')
      const pinnedLine = findBufferLineContaining(headless, '界')
      headless.scrollToLine(pinnedLine)
      const state = captureScrollState(makeHeadlessRestorable(headless))

      expect(state.firstVisibleLogicalCellOffset).toBe(9)
    } finally {
      headless.dispose()
    }
  })
})
