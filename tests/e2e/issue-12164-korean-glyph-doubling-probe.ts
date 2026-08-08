import { Buffer } from 'node:buffer'
import { PNG } from 'pngjs'
import type { Page } from '@stablyai/playwright-test'

// Issue #12164 reports Korean output rendered/copied as `프프로로젝젝트트`.
// This rig reads one emitted line back through both boundaries that exist:
// the xterm data model and the painted canvas. `getSelection()` is a third
// *read* but not a third *source* — xterm's SelectionService resolves it via
// buffer.translateBufferLineToString, so it shares the data model.

export type PayloadCase = {
  id: string
  text: string
  /** Columns the text must occupy when widths are handled correctly. */
  expectedColumns: number
}

export type BufferReading = {
  id: string
  row: number | null
  translateToString: string
  selectionText: string
  cells: string
  cols: number
  rows: number
}

export type CanvasReading = {
  id: string
  row: number
  inkExtentColumns: number
  inkGroups: string[]
}

export type ProbeGrid = { cols: number; rows: number }

type ProbeCell = { getChars: () => string; getWidth: () => number }
type ProbeLine = {
  translateToString: (trimRight?: boolean) => string
  getCell: (x: number) => ProbeCell | undefined
}
type ProbePane = {
  id: number
  container: HTMLElement
  terminal: {
    cols: number
    rows: number
    buffer: {
      active: {
        viewportY: number
        getLine: (index: number) => ProbeLine | undefined
      }
    }
    select: (column: number, row: number, length: number) => void
    clearSelection: () => void
    getSelection: () => string
    _core?: {
      _renderService?: {
        dimensions?: { css?: { cell?: { width: number; height: number } } }
      }
    }
  }
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __issue12164FindPane: () => ProbePane
  }
}

type RasterTarget = {
  clip: { x: number; y: number; width: number; height: number }
  cellWidth: number
  cellHeight: number
  cols: number
  rows: number
  renderer: 'webgl' | 'dom'
}

export async function readGrid(page: Page): Promise<ProbeGrid> {
  return page.evaluate(() => {
    const pane = window.__issue12164FindPane()
    return { cols: pane.terminal.cols, rows: pane.terminal.rows }
  })
}

/**
 * Installs the active-pane lookup as a page global so each probe can be a real
 * (argument-accepting) evaluate function instead of a string expression.
 */
export async function installPaneLookup(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__issue12164FindPane = () => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane?.terminal) {
        throw new Error('No active terminal pane')
      }
      return pane as unknown as ProbePane
    }
  })
}

/**
 * Drops the pane onto the DOM renderer. In-tree comments blame Windows CJK
 * "stale wide-glyph cells" on the DOM renderer specifically
 * (pty-connection.ts:6228), so WebGL alone does not cover the suspect path.
 */
export async function forceDomRenderer(page: Page): Promise<void> {
  // The user-setting gate is the only durable switch: pty-connection re-asserts
  // the pane flag from `terminalGpuAcceleration` on every renderer-policy pass,
  // so setting the pane directly gets reverted.
  await page.evaluate(() => {
    const store = window.__store?.getState() as unknown as {
      updateSettings?: (patch: Record<string, unknown>) => void
    }
    if (!store?.updateSettings) {
      throw new Error('settings store is unavailable')
    }
    store.updateSettings({ terminalGpuAcceleration: 'off' })
  })
}

/** Waits until the fit addon stops resizing the grid, so emit and read agree. */
export async function waitForStableGrid(page: Page, timeoutMs = 10_000): Promise<ProbeGrid> {
  const deadline = Date.now() + timeoutMs
  let previous = await readGrid(page)
  while (Date.now() < deadline) {
    await page.waitForTimeout(300)
    const current = await readGrid(page)
    if (current.cols === previous.cols && current.rows === previous.rows) {
      return current
    }
    previous = current
  }
  return previous
}

/** Locates each payload's viewport row and reads the data model three ways. */
export async function readBuffer(page: Page, cases: PayloadCase[]): Promise<BufferReading[]> {
  return page.evaluate((items: PayloadCase[]) => {
    const pane = window.__issue12164FindPane()
    const terminal = pane.terminal
    const buffer = terminal.buffer.active
    const readings: BufferReading[] = []
    for (const item of items) {
      // Match on the first code point only — a doubled line (`프프로로…`) must
      // still be found, so no two-character sequence of the original is safe.
      const probe = Array.from(item.text)[0] ?? ''
      let row: number | null = null
      for (let candidate = terminal.rows - 1; candidate >= 0; candidate -= 1) {
        const text = buffer.getLine(buffer.viewportY + candidate)?.translateToString(true) ?? ''
        if (text.trimStart().startsWith(probe)) {
          row = candidate
          break
        }
      }
      let translated = ''
      let cells = ''
      let selectionText = ''
      if (row !== null) {
        const line = buffer.getLine(buffer.viewportY + row)
        translated = line?.translateToString(true) ?? ''
        const parts: string[] = []
        for (let column = 0; column < terminal.cols; column += 1) {
          const cell = line?.getCell(column)
          if (!cell) {
            continue
          }
          const chars = cell.getChars()
          if (chars === '' || chars === ' ') {
            continue
          }
          parts.push(`${column}:${JSON.stringify(chars)}/w${cell.getWidth()}`)
        }
        cells = parts.join(' ')
        terminal.clearSelection()
        terminal.select(0, buffer.viewportY + row, terminal.cols)
        selectionText = terminal.getSelection().replace(/\s+$/, '')
        terminal.clearSelection()
      }
      readings.push({
        id: item.id,
        row,
        translateToString: translated.replace(/\s+$/, ''),
        selectionText,
        cells,
        cols: terminal.cols,
        rows: terminal.rows
      })
    }
    return readings
  }, cases)
}

async function readRasterTarget(page: Page): Promise<RasterTarget> {
  return page.evaluate(() => {
    const pane = window.__issue12164FindPane()
    const screen = pane.container.querySelector('.xterm-screen')
    const cell = pane.terminal._core?._renderService?.dimensions?.css?.cell
    if (!screen || !cell) {
      throw new Error('terminal screen is not measurable')
    }
    const rect = screen.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error('terminal screen is not visible')
    }
    const managers = [...(window.__paneManagers?.values() ?? [])] as unknown as {
      getRenderingDiagnostics?: () => { paneId: number; hasWebgl?: boolean }[]
    }[]
    const diagnostics = managers
      .flatMap((manager) => manager.getRenderingDiagnostics?.() ?? [])
      .find((entry) => entry.paneId === pane.id)
    return {
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      cellWidth: cell.width,
      cellHeight: cell.height,
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      renderer: diagnostics?.hasWebgl ? ('webgl' as const) : ('dom' as const)
    }
  })
}

function backgroundOf(
  image: PNG,
  band: { x0: number; y0: number; x1: number; y1: number }
): number {
  const counts = new Map<number, number>()
  for (let y = band.y0; y < band.y1; y += 1) {
    for (let x = band.x0; x < band.x1; x += 1) {
      const offset = (y * image.width + x) * 4
      const key =
        ((image.data[offset] ?? 0) << 16) |
        ((image.data[offset + 1] ?? 0) << 8) |
        (image.data[offset + 2] ?? 0)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let best = 0
  let bestCount = -1
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  return best
}

const INK_DISTANCE = 36

/** Which grid columns carry painted ink on each payload row, straight off the canvas. */
export async function readCanvas(
  page: Page,
  rows: { id: string; row: number }[]
): Promise<{
  readings: CanvasReading[]
  renderer: 'webgl' | 'dom'
  target: RasterTarget
}> {
  const target = await readRasterTarget(page)
  const shot = await page.screenshot({
    clip: target.clip,
    animations: 'disabled'
  })
  const image = PNG.sync.read(Buffer.from(shot))
  const scaleX = image.width / target.clip.width
  const scaleY = image.height / target.clip.height
  const readings: CanvasReading[] = []

  for (const { id, row } of rows) {
    const y0 = Math.max(0, Math.round(row * target.cellHeight * scaleY))
    const y1 = Math.min(image.height, Math.round((row + 1) * target.cellHeight * scaleY))
    // Calibrate on the trailing quarter of the row, which no payload reaches.
    const background = backgroundOf(image, {
      x0: Math.round(image.width * 0.75),
      y0,
      x1: image.width,
      y1
    })
    const bgR = (background >> 16) & 0xff
    const bgG = (background >> 8) & 0xff
    const bgB = background & 0xff
    const inkedCells: number[] = []
    // The pane's floating overlay control paints inside .xterm-screen on the
    // top row, so the last two columns are not terminal ink. Any doubling of a
    // 25-column payload would land near column 50, far inside this window.
    const maxColumn = Math.max(0, target.cols - 2)
    for (let column = 0; column < maxColumn; column += 1) {
      const x0 = Math.round(column * target.cellWidth * scaleX)
      const x1 = Math.min(image.width, Math.round((column + 1) * target.cellWidth * scaleX))
      let inked = false
      for (let y = y0; y < y1 && !inked; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * image.width + x) * 4
          const distance =
            Math.abs((image.data[offset] ?? 0) - bgR) +
            Math.abs((image.data[offset + 1] ?? 0) - bgG) +
            Math.abs((image.data[offset + 2] ?? 0) - bgB)
          if (distance > INK_DISTANCE) {
            inked = true
            break
          }
        }
      }
      if (inked) {
        inkedCells.push(column)
      }
    }
    readings.push({
      id,
      row,
      inkExtentColumns: inkedCells.length ? (inkedCells.at(-1) as number) + 1 : 0,
      inkGroups: groupRuns(inkedCells)
    })
  }
  return { readings, renderer: target.renderer, target }
}

function groupRuns(columns: number[]): string[] {
  const groups: string[] = []
  let start: number | null = null
  let previous: number | null = null
  for (const column of columns) {
    if (start === null) {
      start = column
    } else if (previous !== null && column !== previous + 1) {
      groups.push(`${start}-${previous}`)
      start = column
    }
    previous = column
  }
  if (start !== null && previous !== null) {
    groups.push(`${start}-${previous}`)
  }
  return groups
}
