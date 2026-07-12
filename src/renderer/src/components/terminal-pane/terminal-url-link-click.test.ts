import type { IBufferLine, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { handleTerminalWebLinkClick } from './terminal-web-link-click'
import { installHttpLinkClickFallback } from './terminal-url-link-hit-testing'

const COLS = 179
const ROWS = 59
const INDENT = '     '
const FULL_URL = [
  'http://127.0.0.1:8765/orca-double-open-repro-wrapped/',
  Array.from({ length: 79 }, (_value, index) => `seg${String(index + 1).padStart(4, '0')}`).join(
    '/'
  ),
  '?marker=wrap-test&n=001&pad=',
  'x'.repeat(120)
].join('')
const URL_ROWS = [
  `${FULL_URL.slice(0, 157)}`,
  `${FULL_URL.slice(157, 317)}`,
  `${FULL_URL.slice(317, 477)}`,
  `${FULL_URL.slice(477, 637)}`,
  `${FULL_URL.slice(637, 698)}`,
  `${FULL_URL.slice(698)}`
]
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
  options: { cols?: number; prefix?: string; suffix?: string } = {}
): IBufferLine {
  const cols = options.cols ?? COLS
  const prefix = options.prefix ?? INDENT
  const suffix = options.suffix ?? ''
  const text = `${prefix}${fragment}`.padEnd(cols - suffix.length) + suffix
  return {
    isWrapped: false,
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
              suffix: options?.lineSuffix
            })
        }
      },
      clearSelection
    } as unknown as Terminal,
    registrations,
    clearSelection
  }
}

function mouseEventForRow(row: number): MouseEvent {
  return {
    button: 0,
    metaKey: true,
    ctrlKey: false,
    shiftKey: true,
    defaultPrevented: false,
    clientX: 150,
    clientY: row * 10 + 5,
    preventDefault: vi.fn()
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
      lineSuffix: '│ '
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
})
