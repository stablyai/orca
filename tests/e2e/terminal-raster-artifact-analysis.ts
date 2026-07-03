import { Buffer } from 'node:buffer'
import { PNG } from 'pngjs'
import type { Page } from '@stablyai/playwright-test'

export type TerminalRasterTarget = {
  clip: { x: number; y: number; width: number; height: number }
  cellWidth: number
  cellHeight: number
  rows: number
  cols: number
  renderer: 'webgl' | 'dom'
  modelGrayRows: number[]
  modelStatusRows: number[]
}

export type GraySlab = {
  x: number
  y: number
  width: number
  height: number
}
export type GraySlabAnalysis = {
  slabCount: number
  slabs: GraySlab[]
  rawSlabCount: number
  rawSlabs: GraySlab[]
  staleStatusGlyphRowCount: number
  staleStatusGlyphRows: number[]
  target: TerminalRasterTarget
  schedulerDebug: Record<string, unknown> | null
  replayDebug?: Record<string, unknown>
  duplicateStatusRows?: string[]
}

export const MAX_FINAL_GRAY_SLABS = 0

async function readActiveTerminalRasterTarget(page: Page): Promise<TerminalRasterTarget> {
  return page.evaluate(() => {
    const isGrayRgb = (red: number, green: number, blue: number): boolean => {
      const max = Math.max(red, green, blue)
      const min = Math.min(red, green, blue)
      return max - min <= 9 && max >= 48 && max <= 112
    }

    const isBufferGrayBackground = (cell: unknown): boolean => {
      const record = cell as {
        isBgRGB?: () => boolean
        isBgPalette?: () => boolean
        getBgColor?: () => number
      }
      if (record?.isBgRGB?.()) {
        const color = record.getBgColor?.() ?? 0
        return isGrayRgb((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff)
      }
      if (record?.isBgPalette?.()) {
        const index = record.getBgColor?.() ?? -1
        const rgba =
          pane.terminal._core?._themeService?.colors?.ansi?.[index]?.rgba ??
          pane.terminal._core?._themeService?.colors?.background?.rgba
        if (typeof rgba !== 'number') {
          return false
        }
        return isGrayRgb((rgba >> 24) & 0xff, (rgba >> 16) & 0xff, (rgba >> 8) & 0xff)
      }
      return false
    }

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
    if (!pane) {
      throw new Error('No active terminal pane')
    }
    const screen = pane.container.querySelector<HTMLElement>('.xterm-screen')
    const dimensions = pane.terminal._core?._renderService?.dimensions?.css?.cell
    if (!screen || !dimensions) {
      throw new Error('Active terminal has no measurable xterm screen')
    }
    const diagnostics = manager
      ?.getRenderingDiagnostics()
      .find((diagnostic) => diagnostic.paneId === pane.id)
    const rect = screen.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error('Active terminal screen is not visible for raster capture')
    }
    const activeBuffer = pane.terminal.buffer.active
    const modelGrayRows: number[] = []
    const modelStatusRows: number[] = []
    for (let row = 0; row < pane.terminal.rows; row += 1) {
      const line = activeBuffer.getLine(activeBuffer.viewportY + row)
      const rowText = line?.translateToString(true) ?? ''
      if (/gpt-5\.5|background terminal|\/ps to view|\/stop to close/i.test(rowText)) {
        modelStatusRows.push(row)
      }
      let grayCellCount = 0
      for (let col = 0; col < pane.terminal.cols; col += 1) {
        if (isBufferGrayBackground(line?.getCell(col))) {
          grayCellCount += 1
        }
      }
      if (grayCellCount >= Math.min(8, Math.ceil(pane.terminal.cols * 0.08))) {
        modelGrayRows.push(row)
      }
    }
    return {
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      cellWidth: dimensions.width,
      cellHeight: dimensions.height,
      rows: pane.terminal.rows,
      cols: pane.terminal.cols,
      renderer: diagnostics?.hasWebgl ? 'webgl' : 'dom',
      modelGrayRows,
      modelStatusRows
    }
  })
}

function isGraySlabPixel(red: number, green: number, blue: number, alpha: number): boolean {
  if (alpha < 245) {
    return false
  }
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  return max - min <= 9 && max >= 48 && max <= 112
}

function isCodexStatusCyanPixel(red: number, green: number, blue: number, alpha: number): boolean {
  if (alpha < 160) {
    return false
  }
  return blue >= 160 && green >= 130 && red >= 80 && red <= 180
}

function isCodexStatusGreenPixel(red: number, green: number, blue: number, alpha: number): boolean {
  if (alpha < 160) {
    return false
  }
  return green >= 120 && red >= 60 && red <= 145 && blue >= 45 && blue <= 130
}

function analyzeGraySlabs(
  buffer: Buffer,
  target: TerminalRasterTarget,
  viewport: { width: number; height: number }
): GraySlabAnalysis {
  const image = PNG.sync.read(buffer)
  const scaleX = image.width / viewport.width
  const scaleY = image.height / viewport.height
  const originX = Math.round(target.clip.x * scaleX)
  const originY = Math.round(target.clip.y * scaleY)
  const maxX = Math.min(image.width, originX + Math.round(target.clip.width * scaleX))
  const maxY = Math.min(image.height, originY + Math.round(target.clip.height * scaleY))
  // Tuned to ignore short gray fragments while still catching replay slab bands.
  const minRunWidth = Math.max(32, Math.round(target.cellWidth * scaleX * 14))
  // Require multi-pixel vertical continuity to avoid one-line anti-alias noise.
  const minRunHeight = Math.max(4, Math.round(target.cellHeight * scaleY * 0.35))
  const runs: GraySlab[] = []

  for (let y = originY; y < maxY; y += 1) {
    let runStart: number | null = null
    for (let x = originX; x <= maxX; x += 1) {
      const inside = x < maxX
      const offset = (y * image.width + x) * 4
      const gray =
        inside &&
        isGraySlabPixel(
          image.data[offset] ?? 0,
          image.data[offset + 1] ?? 0,
          image.data[offset + 2] ?? 0,
          image.data[offset + 3] ?? 0
        )
      if (gray && runStart === null) {
        runStart = x
      } else if (!gray && runStart !== null) {
        const width = x - runStart
        if (width >= minRunWidth) {
          runs.push({ x: runStart - originX, y: y - originY, width, height: 1 })
        }
        runStart = null
      }
    }
  }

  const slabs: GraySlab[] = []
  for (const run of runs) {
    const previous = slabs.at(-1)
    if (
      previous &&
      Math.abs(previous.x - run.x) <= 3 &&
      Math.abs(previous.width - run.width) <= 8 &&
      previous.y + previous.height === run.y
    ) {
      previous.height += 1
      continue
    }
    slabs.push({ ...run })
  }

  const meaningfulSlabs = slabs.filter((slab) => slab.height >= minRunHeight)
  const artifactSlabs = meaningfulSlabs.filter((slab) => {
    const slabCenterCssY = (slab.y + slab.height / 2) / scaleY
    const row = Math.floor(slabCenterCssY / target.cellHeight)
    return !target.modelGrayRows.some((grayRow) => Math.abs(grayRow - row) <= 1)
  })
  const statusGlyphRows: number[] = []
  for (let row = 0; row < target.rows; row += 1) {
    let cyanPixelCount = 0
    let greenPixelCount = 0
    const yStart = originY + Math.round(row * target.cellHeight * scaleY)
    const yEnd = Math.min(maxY, yStart + Math.round(target.cellHeight * scaleY))
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = originX; x < maxX; x += 1) {
        const offset = (y * image.width + x) * 4
        if (
          isCodexStatusCyanPixel(
            image.data[offset] ?? 0,
            image.data[offset + 1] ?? 0,
            image.data[offset + 2] ?? 0,
            image.data[offset + 3] ?? 0
          )
        ) {
          cyanPixelCount += 1
        } else if (
          isCodexStatusGreenPixel(
            image.data[offset] ?? 0,
            image.data[offset + 1] ?? 0,
            image.data[offset + 2] ?? 0,
            image.data[offset + 3] ?? 0
          )
        ) {
          greenPixelCount += 1
        }
      }
    }
    if (
      row >= 8 &&
      // Thresholds tuned to classify stale Codex status glyph rows in screenshots.
      cyanPixelCount >= Math.max(12, Math.round(target.cellWidth * scaleX * 3)) &&
      greenPixelCount >= Math.max(24, Math.round(target.cellWidth * scaleX * 8)) &&
      !target.modelStatusRows.some((statusRow) => Math.abs(statusRow - row) <= 1)
    ) {
      statusGlyphRows.push(row)
    }
  }
  return {
    slabCount: artifactSlabs.length,
    slabs: artifactSlabs.slice(0, 12),
    rawSlabCount: meaningfulSlabs.length,
    rawSlabs: meaningfulSlabs.slice(0, 12),
    staleStatusGlyphRowCount: statusGlyphRows.length,
    staleStatusGlyphRows: statusGlyphRows.slice(0, 12),
    target,
    schedulerDebug: null
  }
}

export async function captureGraySlabAnalysis(page: Page): Promise<{
  analysis: GraySlabAnalysis
  screenshot: Buffer
}> {
  const target = await readActiveTerminalRasterTarget(page)
  const schedulerDebug = await page.evaluate(
    () => window.__terminalOutputSchedulerDebug?.snapshot?.() ?? null
  )
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  const screenshot = Buffer.from(await page.screenshot())
  const analysis = analyzeGraySlabs(screenshot, target, viewport)
  analysis.schedulerDebug = schedulerDebug
  return {
    analysis,
    screenshot
  }
}
