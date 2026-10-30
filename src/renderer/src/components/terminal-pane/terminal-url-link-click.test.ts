// @vitest-environment happy-dom
import {
  commitPreparedLinkForRoutingTest,
  installTerminalLinkFallbackForTest
} from './terminal-link-handlers-test-fixtures'
import type { IBufferLine, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { handleTerminalWebLinkClick } from './terminal-web-link-click'
import { TERMINAL_HTTP_URL_MAX_LENGTH } from './terminal-url-link-hit-testing'
import { TERMINAL_HTTP_URL_MAX_LENGTH as maximumHttpUrlLength } from '../../../../shared/terminal-http-link-limits'

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
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  element.append(screen)
  document.body.append(element)
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, cols * 10, rows * 10))
  const add = element.addEventListener.bind(element)
  vi.spyOn(element, 'addEventListener').mockImplementation((name, listener, options) => {
    if (typeof listener === 'function') {
      registrations.push([name, listener, options])
    }
    add(name, listener, options)
  })
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

function mouseEventForRow(
  row: number,
  options: { altKey?: boolean; plain?: boolean } = {}
): MouseEvent {
  return new MouseEvent('mouseup', {
    bubbles: true,
    cancelable: true,
    button: 0,
    metaKey: !options.plain,
    altKey: options.altKey ?? false,
    shiftKey: !options.plain,
    clientX: 150,
    clientY: row * 10 + 5
  })
}

describe('hard-wrapped terminal HTTP clicks', () => {
  it('exports the URL length limit exercised by the extraction tests', () => {
    expect(TERMINAL_HTTP_URL_MAX_LENGTH).toBe(maximumHttpUrlLength)
  })

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
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens the full logical URL once when WebLinksAddon reports only the first row', () => {
    const { terminal, registrations, clearSelection } = makeTerminal()
    const disposable = installTerminalLinkFallbackForTest(terminal, { worktreeId: 'wt-1' })
    const event = mouseEventForRow(0)

    expect(
      handleTerminalWebLinkClick(URL_ROWS[0], event, {
        terminal,
        commit: (event, operation) => {
          terminal.clearSelection()
          return commitPreparedLinkForRoutingTest(event, operation)
        },
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
    expect(event.defaultPrevented).toBe(true)
    expect(clearSelection).toHaveBeenCalled()
    disposable.dispose()
  })

  it('opens the same full URL from a continuation-row fallback click', () => {
    const { terminal } = makeTerminal()
    const disposable = installTerminalLinkFallbackForTest(terminal, { worktreeId: 'wt-1' })
    disposable.press({ metaKey: true, shiftKey: true, clientX: 150, clientY: 35 })
    expect(openUrlMock).toHaveBeenCalledTimes(1)
    expect(openUrlMock).toHaveBeenCalledWith(FULL_URL)
    expect(disposable.writes).toEqual([])
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
        commit: (event, operation) => {
          terminal.clearSelection()
          return commitPreparedLinkForRoutingTest(event, operation)
        },
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
        commit: (event, operation) => {
          terminal.clearSelection()
          return commitPreparedLinkForRoutingTest(event, operation)
        },
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
        commit: (event, operation) => {
          terminal.clearSelection()
          return commitPreparedLinkForRoutingTest(event, operation)
        },
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
        commit: (event, operation) => {
          terminal.clearSelection()
          return commitPreparedLinkForRoutingTest(event, operation)
        },
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith(fullUrl)
  })

  it('does not append an unrelated aligned TUI row to a complete URL', () => {
    const { terminal } = makeTerminal({
      cols: 135,
      urlRows: ['http://example.com/', 'next-token'],
      linePrefix: ' │   ',
      lineSuffix: '│ ',
      softWrapped: false
    })
    const disposable = installTerminalLinkFallbackForTest(terminal, { worktreeId: 'wt-1' })

    expect(
      handleTerminalWebLinkClick('http://example.com/', mouseEventForRow(0), {
        terminal,
        commit: (event, operation) => {
          terminal.clearSelection()
          return commitPreparedLinkForRoutingTest(event, operation)
        },
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith('http://example.com/')

    openUrlMock.mockReset()
    disposable.press({ metaKey: true, clientX: 150, clientY: 15 })
    expect(disposable.writes).toEqual(['\x1b[<0;2;1M', '\x1b[<0;2;1m'])
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
        commit: (event, operation) => {
          terminal.clearSelection()
          return commitPreparedLinkForRoutingTest(event, operation)
        },
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        startupCwd: '/tmp'
      })
    ).toBe(true)

    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith('http://example.com/')
  })

  it('does not glue the next logical line onto a URL that ends mid-row (#8832)', () => {
    const { terminal } = makeTerminal({
      cols: 80,
      urlRows: ['Repo: https://github.com/stablyai/orca/', 'Description: 123'],
      softWrapped: false
    })
    const disposable = installTerminalLinkFallbackForTest(terminal, { worktreeId: 'wt-1' })

    disposable.press({ metaKey: true, clientX: 150, clientY: 5 })

    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith('https://github.com/stablyai/orca/')
    disposable.dispose()
  })

  it('still joins a URL hard-wrapped at the row edge without native wrap metadata', () => {
    const cols = 40
    const url = 'https://example.com/very/long/path/segments/that/continue/more'
    const { terminal } = makeTerminal({
      cols,
      urlRows: [url.slice(0, cols), url.slice(cols)],
      softWrapped: false
    })
    const disposable = installTerminalLinkFallbackForTest(terminal, { worktreeId: 'wt-1' })

    disposable.press({ metaKey: true, clientX: 150, clientY: 5 })

    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(url)
    disposable.dispose()
  })

  it('forwards both child reports when no link is hit', () => {
    const { terminal } = makeTerminal({ urlRows: ['not-a-link'] })
    const disposable = installTerminalLinkFallbackForTest(terminal, { worktreeId: 'wt-1' })
    disposable.press({ metaKey: true })
    expect(disposable.writes).toEqual(['\x1b[<0;2;1M', '\x1b[<0;2;1m'])
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
    disposable.dispose()
  })

  it('consumes a typed primed OSC link through the real press owner', () => {
    const { terminal, clearSelection } = makeTerminal({ urlRows: ['OSC label'] })
    Object.defineProperty(terminal, '_core', {
      value: {
        linkifier: {
          _currentLink: {
            link: {
              text: 'https://example.com/osc',
              range: { start: { x: 1, y: 1 }, end: { x: 20, y: 1 } }
            }
          }
        }
      }
    })
    const disposable = installTerminalLinkFallbackForTest(terminal, { worktreeId: 'wt-1' })
    terminal.element?.addEventListener('mouseup', (event) => {
      handleTerminalWebLinkClick('https://example.com/osc', event, {
        terminal,
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        commit: disposable.ptyMouseSuppression.commit
      })
    })
    disposable.press({ metaKey: true })
    expect(openUrlMock).toHaveBeenCalledExactlyOnceWith('https://example.com/osc')
    expect(clearSelection).toHaveBeenCalledOnce()
    expect(disposable.writes).toEqual([])
    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
    disposable.dispose()
  })

  it('leaves Alt-modified link gestures to the child TUI', () => {
    const { terminal } = makeTerminal()
    const disposable = installTerminalLinkFallbackForTest(terminal, { worktreeId: 'wt-1' })
    disposable.press({ metaKey: true, altKey: true })
    expect(disposable.writes).toEqual(['\x1b[<0;2;1M', '\x1b[<0;2;1m'])
    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
    expect(openUrlMock).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('consumes HTTP reports without toggling the mouse option and refuses a retired source', () => {
    const { terminal, clearSelection } = makeTerminal()
    const disposable = installTerminalLinkFallbackForTest(terminal, { worktreeId: 'wt-1' })
    disposable.press({ metaKey: true })
    expect(openUrlMock).toHaveBeenCalledExactlyOnceWith(FULL_URL)
    expect(clearSelection).toHaveBeenCalledOnce()
    expect(disposable.writes).toEqual([])
    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
    disposable.retire()
    disposable.press({ metaKey: true })
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(disposable.writes).toEqual([])
    disposable.dispose()
  })

  it('owns a plain HTTP click without opening until an action is chosen', () => {
    const request = vi.fn()
    const { terminal } = makeTerminal()
    const disposable: ReturnType<typeof installTerminalLinkFallbackForTest> =
      installTerminalLinkFallbackForTest(terminal, {
        worktreeId: 'wt-1',
        getLinkActionContext: () => ({
          paneId: 1,
          pointerGesture: { canRequestAction: () => true, dispose: vi.fn() },
          commit: disposable.ptyMouseSuppression.commit,
          request,
          focusTerminal: vi.fn()
        })
      })
    disposable.press()
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'url' }))
    expect(disposable.writes).toEqual([])
    expect(openUrlMock).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('forwards a plain HTTP click when action popovers are disabled', () => {
    const { terminal } = makeTerminal()
    const disposable = installTerminalLinkFallbackForTest(terminal, {
      worktreeId: 'wt-1',
      getLinkActionContext: () => null
    })
    disposable.press()
    expect(disposable.writes).toEqual(['\x1b[<0;2;1M', '\x1b[<0;2;1m'])
    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
    expect(openUrlMock).not.toHaveBeenCalled()
    disposable.dispose()
  })
})
