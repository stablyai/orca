import type {
  IBuffer,
  IBufferCell,
  IDecoration,
  IDisposable,
  IMarker,
  ITheme,
  Terminal
} from '@xterm/xterm'
import { useAppStore } from '@/store'
import {
  findOrchestrationPointerSpans,
  type ScreenRow
} from '../../../../../shared/orchestration/mailbox/orchestration-pointer-screen-match'
import { viewportScreenRows } from './terminal-viewport-screen-rows'
import { hexToRgb, rgbaToHex } from '../../../../../shared/color/rgba-contrast'

// Coalesce a TUI's redraw bursts into one viewport read.
const SCAN_DELAY_MS = 60

function noticesHidden(): boolean {
  return useAppStore.getState().settings?.showOrchestrationNotices === false
}

function hexColor(value: string | undefined, fallback: string): string {
  const match = value?.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i)
  if (!match) {
    return fallback
  }
  return rgbaToHex(hexToRgb(match[1]))
}

const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

/** The colour a cell paints behind its text, so the cover matches a TUI's own tinted input row
 *  rather than the terminal theme. */
function cellBackground(
  cell: IBufferCell | undefined,
  theme: ITheme | undefined,
  fallback: string
): string {
  if (!cell) {
    return fallback
  }
  // Inverse cells paint their foreground behind the text.
  const inverse = cell.isInverse() !== 0
  const value = inverse ? cell.getFgColor() : cell.getBgColor()
  if (inverse ? cell.isFgRGB() : cell.isBgRGB()) {
    return `#${value.toString(16).padStart(6, '0')}`
  }
  if ((inverse ? cell.isFgPalette() : cell.isBgPalette()) && value < ANSI_NAMES.length) {
    return hexColor(theme?.[ANSI_NAMES[value]], fallback)
  }
  return hexColor(inverse ? theme?.foreground : theme?.background, fallback)
}

type Cover = { row: number; start: number; end: number; background: string }

/** The cells to paint over each pointer on screen. A row holding nothing but the pointer is wiped
 *  to the terminal's own background, with the blank rows of the tinted band a TUI draws around a
 *  message (Claude Code's input rows), so the spot reads as plain empty lines. */
function pointerCovers(terminal: Terminal, buffer: IBuffer, rows: ScreenRow[]): Cover[] {
  const theme = terminal.options.theme
  const plain = hexColor(theme?.background, '#000000')
  const backgroundAt = (row: number, column: number): string =>
    cellBackground(buffer.getLine(buffer.viewportY + row)?.getCell(column), theme, plain)
  const blank = (row: number): boolean => rows[row].text.trim() === ''
  const onlyPointer = (row: number, start: number, end: number): boolean => {
    const { text, columns } = rows[row]
    for (let index = 0; index < text.length; index++) {
      const column = columns[index] ?? index
      if ((column < start || column >= end) && !/\s/.test(text[index])) {
        return false
      }
    }
    return true
  }
  const wipe = (row: number): Cover => ({ row, start: 0, end: terminal.cols, background: plain })
  const covers: Cover[] = []
  const spans = findOrchestrationPointerSpans(rows)
  spans.forEach((span, index) => {
    const tint = backgroundAt(span.row, span.start)
    if (!onlyPointer(span.row, span.start, span.end)) {
      covers.push({ ...span, background: tint })
      return
    }
    covers.push(wipe(span.row))
    if (tint === plain) {
      return
    }
    if (span.first) {
      for (let row = span.row - 1; row >= 0 && blank(row) && backgroundAt(row, 0) === tint; row--) {
        covers.push(wipe(row))
      }
    }
    if (index === spans.length - 1 || spans[index + 1].first) {
      for (
        let row = span.row + 1;
        row < rows.length && blank(row) && backgroundAt(row, 0) === tint;
        row++
      ) {
        covers.push(wipe(row))
      }
    }
  })
  return covers
}

/** Covers the "You have N orchestration messages" pointer Orca types into terminal agents when
 *  the user hides orchestration notices. Display only: the PTY, the agent and terminal reads keep
 *  the text. */
export function installTerminalOrchestrationNoticeMask(terminal: Terminal): IDisposable {
  const shown = new Map<string, { decoration: IDecoration; marker: IMarker }>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let hidden = noticesHidden()

  const clear = (): void => {
    for (const { decoration, marker } of shown.values()) {
      decoration.dispose()
      marker.dispose()
    }
    shown.clear()
  }

  const scan = (): void => {
    timer = null
    const buffer = terminal.buffer.active
    const rows = hidden ? viewportScreenRows(terminal.rows, buffer) : null
    if (!rows) {
      clear()
      return
    }
    const wanted = new Set<string>()
    for (const cover of pointerCovers(terminal, buffer, rows)) {
      const { start, end, background } = cover
      const line = buffer.viewportY + cover.row
      const text = rows[cover.row].text
      const key = `${buffer.type}:${line}:${start}:${end}:${background}:${text}`
      wanted.add(key)
      const existing = shown.get(key)
      // A TUI's redraw scrolls its screen, and xterm disposes the markers on lines it drops.
      // Trimmed scrollback moves a live marker off the line its key names.
      if (existing && !existing.decoration.isDisposed && existing.marker.line === line) {
        continue
      }
      existing?.marker.dispose()
      const marker = terminal.registerMarker(line - (buffer.baseY + buffer.cursorY))
      if (!marker) {
        continue
      }
      const decoration = terminal.registerDecoration({
        marker,
        x: start,
        width: end - start,
        backgroundColor: background,
        foregroundColor: background,
        layer: 'top'
      })
      if (!decoration) {
        marker.dispose()
        continue
      }
      // The cell colours alone leave styled glyphs showing on some renderers; the element is opaque.
      decoration.onRender((element) => {
        const row = marker.line - terminal.buffer.active.viewportY
        if (row < 0 || row >= terminal.rows) {
          return
        }
        const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
        if (terminal.buffer.active.type === 'alternate' && screen) {
          // xterm hides decorations and stops placing them while a TUI holds the alternate screen.
          const cellWidth = screen.clientWidth / terminal.cols
          const cellHeight = screen.clientHeight / terminal.rows
          element.style.top = `${row * cellHeight}px`
          element.style.left = `${start * cellWidth}px`
          element.style.width = `${Math.round((end - start) * cellWidth)}px`
          element.style.height = `${cellHeight}px`
          element.style.lineHeight = `${cellHeight}px`
        }
        element.style.display = 'block'
        element.style.pointerEvents = 'none'
        element.style.backgroundColor = background
      })
      shown.set(key, { decoration, marker })
    }
    for (const [key, { decoration, marker }] of shown) {
      if (!wanted.has(key)) {
        decoration.dispose()
        marker.dispose()
        shown.delete(key)
      }
    }
  }

  const schedule = (): void => {
    if (!hidden && shown.size === 0) {
      return
    }
    timer ??= setTimeout(scan, SCAN_DELAY_MS)
  }

  const subscriptions: IDisposable[] = [
    terminal.onWriteParsed(schedule),
    terminal.onScroll(schedule),
    terminal.onResize(schedule),
    terminal.buffer.onBufferChange(() => {
      clear()
      schedule()
    })
  ]
  const unsubscribeSettings = useAppStore.subscribe((state, previous) => {
    if (state.settings?.showOrchestrationNotices === previous.settings?.showOrchestrationNotices) {
      return
    }
    hidden = noticesHidden()
    if (timer !== null) {
      clearTimeout(timer)
    }
    scan()
  })
  schedule()

  return {
    dispose: () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      unsubscribeSettings()
      for (const subscription of subscriptions) {
        subscription.dispose()
      }
      clear()
    }
  }
}
