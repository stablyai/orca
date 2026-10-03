/**
 * Renders glyphs into an off-screen probe terminal (WebGL or DOM) cloned from the active pane's
 * font options, then measures each glyph's ink inside its cells from real pixels: the WebGL canvas,
 * or a CDP screenshot of the DOM rows. Used by terminal-cjk-glyph-cell-fit.spec.ts.
 */
import type { Page } from '@stablyai/playwright-test'

export type ProbeRenderer = 'webgl' | 'dom'

/** A glyph run placed at `col` on `row`; each character's ink is measured in its own cells. */
export type ProbeRun = { label: string; row: number; col: number; text: string; cells: number }

export type ProbeOptions = {
  renderer: ProbeRenderer
  fitWideGlyphs: boolean
  lineHeight: number
  content: string
  rows: number
}

export type GlyphInk = {
  label: string
  /** Ink box relative to the glyph's first cell, device px; minX is -1 when nothing is drawn. */
  minX: number
  maxX: number
  minY: number
  maxY: number
  span: number
  /** Ink outside the glyph's cells, left/right in the same row and in the rows above/below. */
  bleed: { left: number; right: number; above: number; below: number }
}

type ProbeTerminal = {
  rows: number
  element?: HTMLElement
  options: Record<string, unknown>
  _core: {
    _renderService: {
      _isPaused: boolean
      refreshRows: (start: number, end: number, immediate: boolean) => void
      dimensions: { css: { cell: { width: number; height: number } } }
    }
  }
  dispose: () => void
  loadAddon: (addon: unknown) => void
  open: (element: HTMLElement) => void
  write: (data: string, callback: () => void) => void
}
type ProbeState = {
  terminal: ProbeTerminal
  host: HTMLElement
  canvas: HTMLCanvasElement | null
  cellWidth: number
  cellHeight: number
}
type ProbeWebglAddon = {
  _renderer: {
    _canvas: HTMLCanvasElement
    dimensions: { device: { cell: { width: number; height: number } } }
  }
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- augmentation must merge into Window
  interface Window {
    __wideGlyphProbe?: ProbeState
  }
}

/** Opens the probe terminal; returns the screen's CSS rect to screenshot for the DOM renderer. */
export async function openWideGlyphProbe(
  page: Page,
  options: ProbeOptions
): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(async (opts) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId = worktreeId ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null) : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the e2e build exposes the pane manager; panes is its private pane map.
    const panes = (manager as unknown as { panes?: Map<number, Record<string, unknown>> })?.panes
    const pane = [...(panes?.values() ?? [])][0]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pane.terminal is an xterm Terminal; its constructor builds the probe.
    const live = pane?.terminal as ProbeTerminal & {
      constructor: new (options: Record<string, unknown>) => ProbeTerminal
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pane.webglAddon is the pane's WebglAddon (or null); its constructor builds the probe's.
    const addonCtor = (pane?.webglAddon as { constructor?: new () => ProbeWebglAddon } | null)
      ?.constructor
    if (!live || (opts.renderer === 'webgl' && !addonCtor)) {
      throw new Error('Active pane internals unavailable')
    }
    const host = document.createElement('div')
    // The DOM probe is screenshotted, so it must paint on top at full opacity.
    host.style.cssText = `position:fixed;left:0;top:0;width:900px;height:900px;pointer-events:none;background:#000;z-index:${opts.renderer === 'dom' ? 2147483647 : -1};opacity:${opts.renderer === 'dom' ? 1 : 0.001}`
    document.body.appendChild(host)
    const terminal = new live.constructor({
      cols: 30,
      rows: opts.rows,
      fontSize: live.options.fontSize,
      fontFamily: live.options.fontFamily,
      fontWeight: live.options.fontWeight,
      fontWeightBold: live.options.fontWeightBold,
      lineHeight: opts.lineHeight,
      rescaleOverlappingGlyphs: true,
      fitWideGlyphs: opts.fitWideGlyphs,
      cursorBlink: false,
      allowProposedApi: true,
      theme: { background: '#000000', foreground: '#ffffff', cursor: '#000000' }
    })
    terminal.open(host)
    const addon = opts.renderer === 'webgl' && addonCtor ? new addonCtor() : null
    if (addon) {
      terminal.loadAddon(addon)
    }
    await new Promise<void>((resolve) => terminal.write(opts.content, resolve))
    await document.fonts.ready
    terminal._core._renderService._isPaused = false
    terminal._core._renderService.refreshRows(0, terminal.rows - 1, true)
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    const rect = screen?.getBoundingClientRect()
    const dpr = window.devicePixelRatio
    const dims = terminal._core._renderService.dimensions.css.cell
    window.__wideGlyphProbe = {
      terminal,
      host,
      canvas: addon?._renderer._canvas ?? null,
      cellWidth: addon?._renderer.dimensions.device.cell.width ?? dims.width * dpr,
      cellHeight: addon?._renderer.dimensions.device.cell.height ?? dims.height * dpr
    }
    return {
      x: rect?.left ?? 0,
      y: rect?.top ?? 0,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0
    }
  }, options)
}

/**
 * Measures every run's glyph ink. `png` is a screenshot of the screen rect (DOM renderer);
 * without it the WebGL canvas is read. Returns the capture as a data URL for manual review.
 */
export async function measureWideGlyphProbe(
  page: Page,
  runs: ProbeRun[],
  png: Buffer | null
): Promise<{ glyphs: GlyphInk[]; cellWidth: number; cellHeight: number; dataUrl: string }> {
  return page.evaluate(
    async ({ probeRuns, pngBase64 }) => {
      const probe = window.__wideGlyphProbe
      if (!probe) {
        throw new Error('probe terminal is not open')
      }
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      let source: CanvasImageSource | null = probe.canvas
      // A WebGL canvas without preserveDrawingBuffer is only readable in the task that drew it.
      probe.terminal._core._renderService.refreshRows(0, probe.terminal.rows - 1, true)
      if (pngBase64) {
        const image = new Image()
        image.src = `data:image/png;base64,${pngBase64}`
        await image.decode()
        source = image
      }
      if (!context || !source) {
        throw new Error('capture unavailable')
      }
      canvas.width =
        source instanceof HTMLImageElement ? source.naturalWidth : (probe.canvas?.width ?? 0)
      canvas.height =
        source instanceof HTMLImageElement ? source.naturalHeight : (probe.canvas?.height ?? 0)
      context.drawImage(source, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const { cellWidth, cellHeight } = probe
      const isInk = (x: number, y: number): boolean => {
        const i = (y * canvas.width + x) * 4
        return pixels[i] + pixels[i + 1] + pixels[i + 2] > 96
      }
      const count = (x0: number, y0: number, x1: number, y1: number): number => {
        let n = 0
        for (
          let y = Math.max(0, Math.round(y0));
          y < Math.min(canvas.height, Math.round(y1));
          y++
        ) {
          for (
            let x = Math.max(0, Math.round(x0));
            x < Math.min(canvas.width, Math.round(x1));
            x++
          ) {
            n += isInk(x, y) ? 1 : 0
          }
        }
        return n
      }
      const glyphs = probeRuns.flatMap((run) =>
        [...run.text].map((char, index) => {
          const left = Math.round((run.col + index * run.cells) * cellWidth)
          const right = Math.round((run.col + (index + 1) * run.cells) * cellWidth)
          const top = Math.round(run.row * cellHeight)
          const bottom = Math.round((run.row + 1) * cellHeight)
          let minX = -1
          let maxX = -1
          let minY = -1
          let maxY = -1
          for (let y = top; y < bottom; y++) {
            // Underline rows reach both edges of the span; glyph ink never does.
            if (isInk(left, y) && isInk(right - 1, y)) {
              continue
            }
            for (let x = left; x < right; x++) {
              if (isInk(x, y)) {
                minX = minX < 0 ? x - left : Math.min(minX, x - left)
                maxX = Math.max(maxX, x - left)
                minY = minY < 0 ? y - top : minY
                maxY = y - top
              }
            }
          }
          return {
            label: `${run.label} ${char}`,
            minX,
            maxX,
            minY,
            maxY,
            span: right - left,
            bleed: {
              left: index === 0 ? count(left - cellWidth, top, left, bottom) : 0,
              right:
                index === [...run.text].length - 1
                  ? count(right, top, right + cellWidth, bottom)
                  : 0,
              above: count(left, top - cellHeight, right, top),
              below: count(left, bottom, right, bottom + cellHeight)
            }
          }
        })
      )
      return { glyphs, cellWidth, cellHeight, dataUrl: canvas.toDataURL('image/png') }
    },
    { probeRuns: runs, pngBase64: png ? png.toString('base64') : null }
  )
}

export async function closeWideGlyphProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = window.__wideGlyphProbe
    probe?.terminal.dispose()
    probe?.host.remove()
    delete window.__wideGlyphProbe
  })
}
