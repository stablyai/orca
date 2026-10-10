/**
 * The terminal font chain must name CJK faces, and Hangul/Han/Kana drawn from them must
 * stay inside their two cells under WebGL. Set ORCA_GLYPH_SCREENSHOT_DIR to also keep a
 * PNG capture of a mixed Latin/CJK line for manual review.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveTerminalManager } from './helpers/terminal'

type ProbeTerminal = {
  rows: number
  options: Record<string, unknown>
  _core: {
    _renderService: {
      _isPaused: boolean
      refreshRows: (start: number, end: number, immediate: boolean) => void
    }
  }
  dispose: () => void
  loadAddon: (addon: ProbeWebglAddon) => void
  open: (element: HTMLElement) => void
  write: (data: string, callback: () => void) => void
}

type ProbeWebglAddon = {
  _renderer: {
    _canvas: HTMLCanvasElement
    dimensions: { device: { cell: { width: number; height: number } } }
  }
}

type PaneInternals = {
  terminal: ProbeTerminal & { constructor: new (options: Record<string, unknown>) => ProbeTerminal }
  webglAddon: (ProbeWebglAddon & { constructor: new () => ProbeWebglAddon }) | null
}

type CellInkReport = {
  label: string
  inkInside: number
  inkLeftNeighbour: number
  inkRightNeighbour: number
}

type WebglProbeResult = {
  fontFamily: string
  cellWidth: number
  cellHeight: number
  glyphs: CellInkReport[]
  sampleLine: string
  dataUrl: string
}

// Why isolated rows: each probed glyph has blank cells on both sides, so ink found
// there is overflow from that glyph.
const PROBE_GLYPHS = [
  { label: 'hangul', glyph: '한' },
  { label: 'hangul', glyph: '글' },
  { label: 'han', glyph: '漢' },
  { label: 'han simplified', glyph: '语' },
  { label: 'hiragana', glyph: 'か' },
  { label: 'katakana', glyph: 'カ' }
]

const SAMPLE_LINE = 'Latin abc 한글 漢字 语言 かなカナ |'

/** Returns the tab whose pane now runs WebGL, or null when no WebGL context is available. */
async function forceActivePaneWebgl(page: Page): Promise<string | null> {
  const tabId = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return state?.activeTabType === 'terminal'
      ? state.activeTabId
      : worktreeId
        ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
        : null
  })
  if (!tabId) {
    return null
  }
  await page.evaluate(
    (id) => window.__paneManagers?.get(id)?.setTerminalGpuAcceleration?.('on'),
    tabId
  )
  return page
    .waitForFunction(
      (id) =>
        (window.__paneManagers?.get(id)?.getRenderingDiagnostics?.() ?? []).some(
          (diagnostic) => diagnostic.hasWebgl
        ),
      tabId,
      { timeout: 15_000 }
    )
    .then(() => tabId)
    .catch(() => null)
}

async function probeWebgl(page: Page, tabId: string): Promise<WebglProbeResult> {
  return page.evaluate(
    async ({ glyphs, sampleLine, tabId: webglTabId }) => {
      const manager = window.__paneManagers?.get(webglTabId)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the e2e build exposes the pane manager; panes is its private pane map.
      const panes = (manager as unknown as { panes?: Map<number, PaneInternals> })?.panes
      const pane = [...(panes?.values() ?? [])][0]
      if (!pane?.webglAddon) {
        throw new Error('Active pane WebGL internals unavailable')
      }
      const fontFamily = String(pane.terminal.options.fontFamily)
      const host = document.createElement('div')
      host.style.cssText =
        'position:fixed;left:0;top:0;width:900px;height:600px;opacity:0.001;pointer-events:none;z-index:-1;background:#000'
      document.body.appendChild(host)
      // Why a probe terminal: it copies the live pane's font options onto a known grid.
      const terminal = new pane.terminal.constructor({
        cols: 44,
        rows: glyphs.length * 2 + 4,
        fontSize: pane.terminal.options.fontSize,
        fontFamily,
        fontWeight: pane.terminal.options.fontWeight,
        fontWeightBold: pane.terminal.options.fontWeightBold,
        rescaleOverlappingGlyphs: pane.terminal.options.rescaleOverlappingGlyphs,
        lineHeight: 1,
        cursorBlink: false,
        allowProposedApi: true,
        theme: { background: '#000000', foreground: '#ffffff', cursor: '#000000' }
      })
      terminal.open(host)
      const addon = new pane.webglAddon.constructor()
      terminal.loadAddon(addon)
      // Probe rows at 1, 3, 5…; each glyph starts at column 2. The sample line goes last.
      let content = '\x1b[?25l\r\n'
      for (const { glyph } of glyphs) {
        content += `  ${glyph}\r\n\r\n`
      }
      content += `  ${sampleLine}`
      await new Promise<void>((resolve) => terminal.write(content, resolve))
      await document.fonts.ready
      terminal._core._renderService._isPaused = false
      terminal._core._renderService.refreshRows(0, terminal.rows - 1, true)
      const source = addon._renderer._canvas
      const cellWidth = addon._renderer.dimensions.device.cell.width
      const cellHeight = addon._renderer.dimensions.device.cell.height
      const canvas = document.createElement('canvas')
      canvas.width = source.width
      canvas.height = source.height
      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error('capture context unavailable')
      }
      context.drawImage(source, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const countInk = (x0: number, y0: number, x1: number, y1: number): number => {
        let count = 0
        const yEnd = Math.min(canvas.height, Math.round(y1))
        const xEnd = Math.min(canvas.width, Math.round(x1))
        for (let y = Math.max(0, Math.round(y0)); y < yEnd; y++) {
          for (let x = Math.max(0, Math.round(x0)); x < xEnd; x++) {
            const i = (y * canvas.width + x) * 4
            if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 96) {
              count += 1
            }
          }
        }
        return count
      }
      const reports = glyphs.map(({ label, glyph }, index) => {
        const top = (1 + index * 2) * cellHeight
        const left = 2 * cellWidth
        const right = left + 2 * cellWidth
        return {
          label: `${label} ${glyph}`,
          inkInside: countInk(left, top, right, top + cellHeight),
          inkLeftNeighbour: countInk(left - cellWidth, top, left, top + cellHeight),
          inkRightNeighbour: countInk(right, top, right + cellWidth, top + cellHeight)
        }
      })
      // Keep only the sample line (plus one row of margin) in the capture.
      const sampleTop = (1 + glyphs.length * 2 - 1) * cellHeight
      const crop = document.createElement('canvas')
      crop.width = canvas.width
      crop.height = Math.round(cellHeight * 3)
      crop.getContext('2d')?.drawImage(canvas, 0, -sampleTop)
      const dataUrl = crop.toDataURL('image/png')
      terminal.dispose()
      host.remove()
      return { fontFamily, cellWidth, cellHeight, glyphs: reports, sampleLine, dataUrl }
    },
    { glyphs: PROBE_GLYPHS, sampleLine: SAMPLE_LINE, tabId }
  )
}

test.describe('terminal CJK glyph cell fit', () => {
  test('@headful lists CJK fallback faces and keeps their glyphs inside two cells under WebGL', async ({
    orcaPage
  }) => {
    await waitForActiveTerminalManager(orcaPage)
    const tabId = await forceActivePaneWebgl(orcaPage)
    if (!tabId) {
      test.skip(true, 'WebGL unavailable in this environment')
      return
    }
    const webgl = await probeWebgl(orcaPage, tabId)
    const screenshotDir = process.env.ORCA_GLYPH_SCREENSHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      writeFileSync(
        path.join(screenshotDir, 'webgl-sample-line.png'),
        Buffer.from(webgl.dataUrl.split(',')[1] ?? '', 'base64')
      )
      writeFileSync(
        path.join(screenshotDir, 'webgl-probe.json'),
        JSON.stringify({ ...webgl, dataUrl: undefined }, null, 2)
      )
    }

    // The chain names CJK faces between the Latin/symbol fonts and the generic keyword.
    const families = webgl.fontFamily.split(',').map((family) => family.trim())
    const firstCjk = families.findIndex((family) =>
      /PingFang|Hiragino|Apple SD Gothic Neo|Malgun Gothic|Microsoft YaHei|Yu Gothic|Noto Sans (Mono )?CJK/.test(
        family
      )
    )
    expect(firstCjk, webgl.fontFamily).toBeGreaterThan(families.indexOf('"Hack Nerd Font"'))
    expect(families.at(-1)).toBe('monospace')

    for (const glyph of webgl.glyphs) {
      expect(glyph.inkInside, glyph.label).toBeGreaterThan(0)
      expect(glyph.inkLeftNeighbour, glyph.label).toBe(0)
      expect(glyph.inkRightNeighbour, glyph.label).toBe(0)
    }
  })
})
