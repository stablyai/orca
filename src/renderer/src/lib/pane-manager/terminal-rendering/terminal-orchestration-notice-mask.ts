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
import { translate } from '@/i18n/i18n'
import {
  findOrchestrationPointerSpans,
  type ScreenRow
} from '../../../../../shared/orchestration/mailbox/orchestration-pointer-screen-match'
import { hexToRgb, mix, rgbaToHex } from '../../../../../shared/color/rgba-contrast'

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

/** The colour a cell paints behind (`bg`) or as (`fg`) its text, so the cover and its label
 *  match a TUI's own tinted input row rather than the terminal theme. */
function cellColor(
  cell: IBufferCell | undefined,
  layer: 'bg' | 'fg',
  theme: ITheme | undefined,
  fallback: string
): string {
  if (!cell) {
    return fallback
  }
  // Inverse cells swap the two.
  const bg = (layer === 'bg') !== (cell.isInverse() !== 0)
  const value = bg ? cell.getBgColor() : cell.getFgColor()
  if (bg ? cell.isBgRGB() : cell.isFgRGB()) {
    return `#${value.toString(16).padStart(6, '0')}`
  }
  if ((bg ? cell.isBgPalette() : cell.isFgPalette()) && value < ANSI_NAMES.length) {
    return hexColor(theme?.[ANSI_NAMES[value]], fallback)
  }
  return hexColor(bg ? theme?.background : theme?.foreground, fallback)
}

function viewportRows(terminal: Terminal, buffer: IBuffer): ScreenRow[] | null {
  const top = buffer.viewportY
  const lines = Array.from({ length: terminal.rows }, (_, offset) => buffer.getLine(top + offset))
  // Most output never mentions orchestration; skip the per-cell read for it.
  if (!lines.some((line) => line?.translateToString(true).includes('orchestration'))) {
    return null
  }
  const cell = buffer.getNullCell()
  return lines.map((line) => {
    let text = ''
    const columns: number[] = []
    for (let column = 0; line && column < line.length; column++) {
      const read = line.getCell(column, cell)
      const chars = read?.getChars() ?? ''
      for (const char of chars) {
        text += char
        columns.push(column)
      }
      // The second cell of a wide character has width 0 and no text of its own.
      if (!chars && read?.getWidth() !== 0) {
        text += ' '
        columns.push(column)
      }
    }
    return { text, columns, wrapped: line?.isWrapped === true }
  })
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
    const rows = hidden ? viewportRows(terminal, buffer) : null
    if (!rows) {
      clear()
      return
    }
    const theme = terminal.options.theme
    const wanted = new Set<string>()
    for (const span of findOrchestrationPointerSpans(rows)) {
      const line = buffer.viewportY + span.row
      const text = rows[span.row].text
      const cell = buffer.getLine(line)?.getCell(span.start)
      const background = cellColor(cell, 'bg', theme, '#000000')
      const label = rgbaToHex(
        mix(hexToRgb(cellColor(cell, 'fg', theme, '#ffffff')), hexToRgb(background), 55)
      )
      const key = `${buffer.type}:${line}:${span.start}:${span.end}:${span.first}:${background}:${text}`
      wanted.add(key)
      const existing = shown.get(key)
      // A TUI's redraw scrolls its screen, and xterm disposes the markers on lines it drops.
      if (existing && !existing.decoration.isDisposed) {
        continue
      }
      existing?.marker.dispose()
      const marker = terminal.registerMarker(line - (buffer.baseY + buffer.cursorY))
      if (!marker) {
        continue
      }
      const decoration = terminal.registerDecoration({
        marker,
        x: span.start,
        width: span.end - span.start,
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
          element.style.left = `${span.start * cellWidth}px`
          element.style.width = `${Math.round((span.end - span.start) * cellWidth)}px`
          element.style.height = `${cellHeight}px`
          element.style.lineHeight = `${cellHeight}px`
        }
        element.style.display = 'block'
        element.style.pointerEvents = 'none'
        element.style.backgroundColor = background
        if (!span.first) {
          return
        }
        element.style.color = label
        element.style.fontFamily = terminal.options.fontFamily ?? ''
        element.style.fontSize = `${terminal.options.fontSize ?? 13}px`
        element.style.overflow = 'hidden'
        element.style.whiteSpace = 'nowrap'
        element.textContent = translate(
          'auto.lib.terminalOrchestrationNoticeMask.label',
          'Orca delivered an orchestration message'
        )
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
