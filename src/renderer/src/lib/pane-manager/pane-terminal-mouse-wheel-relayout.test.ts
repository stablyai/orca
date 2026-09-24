// @vitest-environment happy-dom

import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachTerminalMouseWheelMultiplier,
  refreshTerminalMouseWheelHandling
} from './pane-terminal-mouse-wheel'

/**
 * Relayout can leave xterm's SmoothScrollableElement consuming wheel events
 * (`handleMouseWheel: true`) while a fullscreen TUI still has mouse reporting
 * armed. Native viewport scroll then eats the wheel; Claude Code sees nothing.
 * Refresh re-fires the live mouse protocol so viewport wheel handling and the
 * enable-mouse-events class match parser state.
 */

type XtermScrollable = {
  options: { handleMouseWheel: boolean }
  updateOptions: (options: { handleMouseWheel: boolean }) => void
}

type XtermMouseRelayoutCore = {
  mouseStateService: { activeProtocol: string }
  _viewport: { _scrollableElement: XtermScrollable }
}

const opened: { terminal: Terminal; host: HTMLElement }[] = []

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isXtermScrollable(value: unknown): value is XtermScrollable {
  if (!isRecord(value) || !isRecord(value.options)) {
    return false
  }
  return (
    typeof value.options.handleMouseWheel === 'boolean' && typeof value.updateOptions === 'function'
  )
}

function isXtermMouseRelayoutCore(value: unknown): value is XtermMouseRelayoutCore {
  if (!isRecord(value) || !isRecord(value.mouseStateService) || !isRecord(value._viewport)) {
    return false
  }
  return (
    typeof value.mouseStateService.activeProtocol === 'string' &&
    isXtermScrollable(value._viewport._scrollableElement)
  )
}

function getMouseRelayoutCore(terminal: Terminal): XtermMouseRelayoutCore {
  const core = '_core' in terminal ? terminal._core : undefined
  if (!isXtermMouseRelayoutCore(core)) {
    throw new Error('vendored xterm mouse/viewport internals moved; update the relayout refresh')
  }
  return core
}

function openMouseReportingTerminal(): Terminal {
  const host = document.createElement('div')
  host.style.width = '800px'
  host.style.height = '400px'
  document.body.appendChild(host)
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  terminal.open(host)
  attachTerminalMouseWheelMultiplier(terminal)
  opened.push({ terminal, host })
  return terminal
}

describe('terminal mouse wheel handling after relayout', () => {
  beforeEach(() => {
    // happy-dom has no canvas text metrics; xterm measures glyphs on open().
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 }),
      fontBoundingBoxAscent: 8,
      fontBoundingBoxDescent: 2
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    for (const { terminal, host } of opened.splice(0)) {
      terminal.dispose()
      host.remove()
    }
    vi.restoreAllMocks()
  })

  it('restores viewport wheel forwarding and the mouse-events class after a stale relayout', async () => {
    const terminal = openMouseReportingTerminal()
    await write(terminal, '\x1b[?1003h\x1b[?1006h')

    expect(terminal.modes.mouseTrackingMode).toBe('any')
    expect(terminal.element?.classList.contains('enable-mouse-events')).toBe(true)

    const scrollable = getMouseRelayoutCore(terminal)._viewport._scrollableElement
    expect(scrollable.options.handleMouseWheel).toBe(false)

    // Relayout left native wheel handling armed and dropped the reporting class.
    scrollable.updateOptions({ handleMouseWheel: true })
    terminal.element?.classList.remove('enable-mouse-events')
    expect(scrollable.options.handleMouseWheel).toBe(true)
    expect(terminal.element?.classList.contains('enable-mouse-events')).toBe(false)

    refreshTerminalMouseWheelHandling(terminal)

    expect(scrollable.options.handleMouseWheel).toBe(false)
    expect(terminal.element?.classList.contains('enable-mouse-events')).toBe(true)
  })

  it('restores the same mouse-wheel binding after a resize that left native handling stale', async () => {
    const terminal = openMouseReportingTerminal()
    await write(terminal, '\x1b[?1003h\x1b[?1006h')
    terminal.resize(100, 30)

    const scrollable = getMouseRelayoutCore(terminal)._viewport._scrollableElement
    scrollable.updateOptions({ handleMouseWheel: true })
    terminal.element?.classList.remove('enable-mouse-events')

    refreshTerminalMouseWheelHandling(terminal)

    expect(scrollable.options.handleMouseWheel).toBe(false)
    expect(terminal.element?.classList.contains('enable-mouse-events')).toBe(true)
  })
})
