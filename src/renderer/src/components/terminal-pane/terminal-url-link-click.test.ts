import type { IBufferLine, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { handleTerminalWebLinkClick } from './terminal-web-link-click'
import { installHttpLinkClickFallback } from './terminal-url-link-hit-testing'

const COLS = 157
const ROWS = 59
const INDENT = ''
const FULL_URL = [
  'http://127.0.0.1:8765/orca-double-open-repro-wrapped/',
  Array.from({ length: 79 }, (_value, index) => `seg${String(index + 1).padStart(4, '0')}`).join(
    '/'
  ),
  '?marker=wrap-test&n=001&pad=',
  'x'.repeat(120)
].join('')
const URL_ROWS = Array.from({ length: Math.ceil(FULL_URL.length / COLS) }, (_value, index) =>
  FULL_URL.slice(index * COLS, (index + 1) * COLS)
)
const FRAMED_ROW_STARTS = [
  0,
  FULL_URL.indexOf('seg0008/'),
  FULL_URL.indexOf('seg0022/'),
  FULL_URL.indexOf('seg0036/'),
  FULL_URL.indexOf('seg0050/'),
  FULL_URL.indexOf('seg0064/'),
  FULL_URL.indexOf('seg0078/'),
  FULL_URL.indexOf('test&n=001'),
  FULL_URL.length - 19
]
const FRAMED_URL_ROWS = FRAMED_ROW_STARTS.map((start, index) =>
  FULL_URL.slice(start, FRAMED_ROW_STARTS[index + 1])
)

const openUrlMock = vi.fn()

type ListenerRegistration = [string, EventListener, AddEventListenerOptions | boolean | undefined]

function makeBufferLine(
  fragment: string,
  options: { cols?: number; prefix?: string; suffix?: string; isWrapped?: boolean } = {}
): IBufferLine {
  const cols = options.cols ?? COLS
  const prefix = options.prefix ?? INDENT
  const suffix = options.suffix ?? ''
  const text = `${prefix}${fragment}`.padEnd(cols - suffix.length) + suffix
  return {
    isWrapped: options.isWrapped ?? false,
    length: cols,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = text.length,
      outColumns?: number[]
    ) => {
      if (outColumns) {
        outColumns.splice(
          0,
          outColumns.length,
          ...Array.from(
            { length: endColumn - startColumn + 1 },
            (_value, index) => index + startColumn
          )
        )
      }
      return text.slice(startColumn, endColumn)
    }
  } as IBufferLine
}

function makeTerminal(options?: {
  cols?: number
  rows?: number
  urlRows?: string[]
  linePrefix?: string
  lineSuffix?: string
  softWrapped?: boolean
}): {
  terminal: Terminal
  registrations: ListenerRegistration[]
  clearSelection: ReturnType<typeof vi.fn>
} {
  const cols = options?.cols ?? COLS
  const rows = options?.rows ?? ROWS
  const urlRows = options?.urlRows ?? URL_ROWS
  const registrations: ListenerRegistration[] = []
  const ownerWindow = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
  const ownerDocument = {
    defaultView: ownerWindow,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
  const screen = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cols * 10, height: rows * 10 })
  }
  const element = {
    ownerDocument,
    querySelector: vi.fn(() => screen),
    addEventListener: vi.fn(
      (name: string, listener: EventListener, options?: AddEventListenerOptions | boolean) => {
        registrations.push([name, listener, options])
      }
    ),
    removeEventListener: vi.fn()
  }
  const clearSelection = vi.fn()
  return {
    terminal: {
      cols,
      rows,
      options: { mouseEventsRequireAlt: false },
      element,
      buffer: {
        active: {
          viewportY: 0,
          getLine: (y: number) =>
            urlRows[y] &&
            makeBufferLine(urlRows[y], {
              cols,
              prefix: options?.linePrefix,
              suffix: options?.lineSuffix,
              isWrapped: (options?.softWrapped ?? true) && y > 0
            })
        }
      },
      clearSelection
    } as unknown as Terminal,
    registrations,
    clearSelection
  }
}

function mouseEventForRow(row: number, options: { altKey?: boolean } = {}): MouseEvent {
  let defaultPrevented = false
  return {
    button: 0,
    metaKey: true,
    ctrlKey: false,
    altKey: options.altKey ?? false,
    shiftKey: true,
    get defaultPrevented() {
      return defaultPrevented
    },
    clientX: 150,
    clientY: row * 10 + 5,
    preventDefault: vi.fn(() => {
      defaultPrevented = true
    })
  } as unknown as MouseEvent
}

describe('hard-wrapped terminal HTTP clicks', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    vi.stubGlobal('window', { api: { shell: { openUrl: openUrlMock } } })
    registerHttpLinkStoreAccessor(() => ({
      settings: { openLinksInApp: false },
      setActiveWorktree: vi.fn(),
      createBrowserTab: vi.fn()
    }))
    openUrlMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the full logical URL once when WebLinksAddon reports only the first row', () => {
    const { terminal, registrations, clearSelection } = makeTerminal()
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })
    const event = mouseEventForRow(0)

    expect(
      handleTerminalWebLinkClick(URL_ROWS[0], event, {
        terminal,
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(true)

    const fallback = registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options === undefined
    )?.[1]
    expect(fallback).toBeDefined()
    fallback!(event)

    expect(openUrlMock).toHaveBeenCalledTimes(1)
    expect(openUrlMock).toHaveBeenCalledWith(FULL_URL)
    expect(new URL(URL_ROWS[0]).pathname).toHaveLength(136)
    expect(`${new URL(FULL_URL).pathname}${new URL(FULL_URL).search}`).toHaveLength(811)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(clearSelection).toHaveBeenCalled()
    disposable.dispose()
  })

  it('opens the same full URL from a continuation-row fallback click', () => {
    const { terminal, registrations } = makeTerminal()
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })
    const event = mouseEventForRow(3)
    const fallback = registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options === undefined
    )?.[1]

    fallback!(event)

    expect(openUrlMock).toHaveBeenCalledTimes(1)
    expect(openUrlMock).toHaveBeenCalledWith(FULL_URL)
    disposable.dispose()
  })

  it('reconstructs a URL split across cursor-positioned rows inside a TUI frame', () => {
    const { terminal } = makeTerminal({
      cols: 135,
      urlRows: FRAMED_URL_ROWS,
      linePrefix: ' │   ',
      lineSuffix: '│ ',
      softWrapped: false
    })
    const event = mouseEventForRow(0)

    expect(
      handleTerminalWebLinkClick(FRAMED_URL_ROWS[0], event, {
        terminal,
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(true)

    expect(openUrlMock).toHaveBeenCalledTimes(1)
    expect(openUrlMock).toHaveBeenCalledWith(FULL_URL)
    expect(new URL(FRAMED_URL_ROWS[0]).pathname).toHaveLength(88)
  })

  it('reconstructs a URL that fills each cursor-positioned TUI row up to its frame', () => {
    const cols = 135
    const linePrefix = ' │   '
    const lineSuffix = '│ '
    const contentWidth = cols - linePrefix.length - lineSuffix.length
    const fullWidthRows = Array.from(
      { length: Math.ceil(FULL_URL.length / contentWidth) },
      (_value, index) => FULL_URL.slice(index * contentWidth, (index + 1) * contentWidth)
    )
    const { terminal } = makeTerminal({
      cols,
      urlRows: fullWidthRows,
      linePrefix,
      lineSuffix,
      softWrapped: false
    })

    expect(
      handleTerminalWebLinkClick(fullWidthRows[0], mouseEventForRow(0), {
        terminal,
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(true)

    expect(openUrlMock).toHaveBeenCalledTimes(1)
    expect(openUrlMock).toHaveBeenCalledWith(FULL_URL)
  })

  it('reconstructs supported URLs spanning more than twenty framed rows', () => {
    const cols = 80
    const linePrefix = ' │   '
    const lineSuffix = '│ '
    const contentWidth = cols - linePrefix.length - lineSuffix.length
    const longUrl = `http://example.com/${'a'.repeat(contentWidth * 20)}`
    const urlRows = Array.from(
      { length: Math.ceil(longUrl.length / contentWidth) },
      (_value, index) => longUrl.slice(index * contentWidth, (index + 1) * contentWidth)
    )
    const { terminal } = makeTerminal({
      cols,
      urlRows,
      linePrefix,
      lineSuffix,
      softWrapped: false
    })

    expect(urlRows).toHaveLength(21)
    expect(
      handleTerminalWebLinkClick(urlRows[0], mouseEventForRow(0), {
        terminal,
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith(longUrl)
  })

  it('keeps nested HTTP URLs inside a wrapped query parameter', () => {
    const cols = 80
    const linePrefix = ' │   '
    const lineSuffix = '│ '
    const contentWidth = cols - linePrefix.length - lineSuffix.length
    const firstRow = `http://example.com/${'a'.repeat(contentWidth - 'http://example.com/'.length)}`
    const nestedQuery = 'segment?redirect=https://nested.example/path'
    const secondRow = `${nestedQuery}${'b'.repeat(contentWidth - nestedQuery.length)}`
    const urlRows = [firstRow, secondRow, 'tail']
    const fullUrl = urlRows.join('')
    const { terminal } = makeTerminal({
      cols,
      urlRows,
      linePrefix,
      lineSuffix,
      softWrapped: false
    })

    expect(
      handleTerminalWebLinkClick(firstRow, mouseEventForRow(0), {
        terminal,
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith(fullUrl)
  })

  it('does not append an unrelated aligned TUI row to a complete URL', () => {
    const { terminal, registrations } = makeTerminal({
      cols: 135,
      urlRows: ['http://example.com/', 'next-token'],
      linePrefix: ' │   ',
      lineSuffix: '│ ',
      softWrapped: false
    })
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })

    expect(
      handleTerminalWebLinkClick('http://example.com/', mouseEventForRow(0), {
        terminal,
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith('http://example.com/')

    openUrlMock.mockReset()
    const fallback = registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options === undefined
    )?.[1]
    fallback!(mouseEventForRow(1))
    expect(openUrlMock).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('does not join a complete URL to multiple unrelated framed rows', () => {
    const unrelatedFilledRow = 'a'.repeat(103)
    const { terminal } = makeTerminal({
      cols: 110,
      urlRows: ['http://example.com/', unrelatedFilledRow, 'unrelated'],
      linePrefix: ' │   ',
      lineSuffix: '│ ',
      softWrapped: false
    })

    expect(
      handleTerminalWebLinkClick('http://example.com/', mouseEventForRow(0), {
        terminal,
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(true)

    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith('http://example.com/')
  })

  it('does not glue the next logical line onto a URL that ends mid-row (#8832)', () => {
    const { terminal, registrations } = makeTerminal({
      cols: 80,
      urlRows: ['Repo: https://github.com/stablyai/orca/', 'Description: 123'],
      softWrapped: false
    })
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })

    const fallback = registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options === undefined
    )?.[1]
    fallback!(mouseEventForRow(0))

    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith('https://github.com/stablyai/orca/')
    disposable.dispose()
  })

  it('still joins a URL hard-wrapped at the row edge without native wrap metadata', () => {
    const cols = 40
    const url = 'https://example.com/very/long/path/segments/that/continue/more'
    const { terminal, registrations } = makeTerminal({
      cols,
      urlRows: [url.slice(0, cols), url.slice(cols)],
      softWrapped: false
    })
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })

    const fallback = registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options === undefined
    )?.[1]
    fallback!(mouseEventForRow(0))

    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(url)
    disposable.dispose()
  })

  it('does not suppress a modifier-click when the buffer position is not an HTTP link', () => {
    const { terminal, registrations } = makeTerminal({ urlRows: ['not-a-link'] })
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })
    const mouseDown = registrations.find(([name]) => name === 'mousedown')?.[1]

    mouseDown!(mouseEventForRow(0))

    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
    disposable.dispose()
  })

  it('leaves Alt-modified link gestures to the child TUI', () => {
    const { terminal, registrations } = makeTerminal()
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })
    const mouseDown = registrations.find(([name]) => name === 'mousedown')?.[1]
    const event = mouseEventForRow(0, { altKey: true })

    mouseDown!(event)
    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
    expect(
      handleTerminalWebLinkClick(URL_ROWS[0], event, {
        terminal,
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(false)
    expect(openUrlMock).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('temporarily suppresses PTY mouse reporting at an HTTP link position', async () => {
    const { terminal, registrations } = makeTerminal()
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })
    const mouseDown = registrations.find(([name]) => name === 'mousedown')?.[1]
    const mouseUp = registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options !== undefined
    )?.[1]

    mouseDown!(mouseEventForRow(0))
    expect(terminal.options.mouseEventsRequireAlt).toBe(true)

    mouseUp!(mouseEventForRow(0))
    await Promise.resolve()
    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
    disposable.dispose()
  })
})
