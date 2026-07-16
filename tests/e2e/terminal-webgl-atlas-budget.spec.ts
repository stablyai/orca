import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveTerminalManager } from './helpers/terminal'

type AtlasPage = {
  canvas: HTMLCanvasElement
  _glyphs: unknown[]
}

type TextureAtlas = {
  constructor: { maxAtlasPages: number; maxTextureSize: number }
  pages: AtlasPage[]
}

type TestTerminal = {
  rows: number
  _core: {
    _renderService: {
      _isPaused: boolean
      _needsFullRefresh: boolean
      refreshRows: (start: number, end: number, immediate: boolean) => void
    }
  }
  dispose: () => void
  loadAddon: (addon: TestWebglAddon) => void
  open: (element: HTMLElement) => void
  write: (data: string, callback: () => void) => void
}

type TestWebglAddon = {
  _renderer: {
    _canvas: HTMLCanvasElement
    _charAtlas: TextureAtlas & { _evictAllPages?: () => void }
    dimensions: { device: { cell: { height: number } } }
  }
  clearTextureAtlas: () => void
}

type ManagedPaneInternals = {
  terminal: TestTerminal & { constructor: new (options: Record<string, unknown>) => TestTerminal }
  webglAddon: TestWebglAddon & { constructor: new () => TestWebglAddon }
}

type AtlasBudgetResult = {
  baselineInkPixels: number
  budget: number
  evictions: number
  maxPages: number
  pagesAfterStorm: number
  pagesAfterWipe: number
  pixelDiffAfterWipe: number
  realBudget: number
  shared: boolean
  stormEvictions: number
  stormRounds: number
  unbindableAfterStorm: number
  unbindableAfterWipe: number
}

async function forceActivePaneWebgl(page: Page): Promise<boolean> {
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
    return false
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
    .then(() => true)
    .catch(() => false)
}

async function runAtlasBudgetScenario(page: Page): Promise<AtlasBudgetResult> {
  return page.evaluate(async () => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager
      ? ([
          ...((
            manager as unknown as { panes?: Map<number, ManagedPaneInternals> }
          ).panes?.values() ?? [])
        ][0] ?? null)
      : null
    if (!pane?.webglAddon) {
      throw new Error('Active pane WebGL internals unavailable')
    }

    const TerminalCtor = pane.terminal.constructor
    const WebglCtor = pane.webglAddon.constructor
    const AtlasCtor = pane.webglAddon._renderer._charAtlas.constructor
    const realBudget = AtlasCtor.maxAtlasPages
    const realMaxTextureSize = AtlasCtor.maxTextureSize
    const budget = 4
    const host = document.createElement('div')
    host.style.cssText =
      'position:fixed;inset:0;width:2700px;height:800px;opacity:0.001;pointer-events:none;z-index:-1'
    const containers = [document.createElement('div'), document.createElement('div')]
    for (const container of containers) {
      container.style.cssText = 'display:inline-block;width:1300px;height:700px'
      host.appendChild(container)
    }
    document.body.appendChild(host)

    const options = {
      cols: 60,
      rows: 16,
      fontSize: 32,
      fontFamily: 'Menlo, monospace',
      cursorBlink: false,
      scrollback: 5000
    }
    const makeTerminal = (
      container: HTMLElement
    ): { terminal: TestTerminal; addon: TestWebglAddon } => {
      const terminal = new TerminalCtor(options)
      terminal.open(container)
      const addon = new WebglCtor()
      terminal.loadAddon(addon)
      return { terminal, addon }
    }
    const write = (terminal: TestTerminal, data: string): Promise<void> =>
      new Promise((resolve) => terminal.write(data, resolve))
    const render = (terminal: TestTerminal): void => {
      terminal._core._renderService._isPaused = false
      terminal._core._renderService._needsFullRefresh = false
      terminal._core._renderService.refreshRows(0, terminal.rows - 1, true)
    }
    const capture = (addon: TestWebglAddon, height: number): Uint8ClampedArray => {
      const canvas = document.createElement('canvas')
      canvas.width = addon._renderer._canvas.width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error('Screenshot canvas context unavailable')
      }
      context.drawImage(addon._renderer._canvas, 0, 0)
      return context.getImageData(0, 0, canvas.width, height).data
    }
    const pixelDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
      let count = 0
      for (let i = 0; i < Math.min(a.length, b.length); i += 4) {
        if (
          Math.abs(a[i] - b[i]) > 8 ||
          Math.abs(a[i + 1] - b[i + 1]) > 8 ||
          Math.abs(a[i + 2] - b[i + 2]) > 8
        ) {
          count += 1
        }
      }
      return count
    }
    const pixelsDifferentFromFirst = (pixels: Uint8ClampedArray): number => {
      const [red, green, blue] = pixels
      let count = 0
      for (let i = 0; i < pixels.length; i += 4) {
        if (
          Math.abs(pixels[i] - red) > 8 ||
          Math.abs(pixels[i + 1] - green) > 8 ||
          Math.abs(pixels[i + 2] - blue) > 8
        ) {
          count += 1
        }
      }
      return count
    }

    let terminalA: TestTerminal | undefined
    let terminalB: TestTerminal | undefined
    try {
      AtlasCtor.maxAtlasPages = budget
      const A = makeTerminal(containers[0])
      terminalA = A.terminal
      const B = makeTerminal(containers[1])
      terminalB = B.terminal
      await new Promise((resolve) => setTimeout(resolve, 0))
      const atlas = B.addon._renderer._charAtlas
      const shared = A.addon._renderer._charAtlas === atlas
      let evictions = 0
      const originalEvict = atlas._evictAllPages?.bind(atlas)
      if (originalEvict) {
        atlas._evictAllPages = () => {
          evictions += 1
          originalEvict()
        }
      }
      let maxPages = atlas.pages.length
      let nextCodePoint = 0x4e00
      let stormRounds = 0
      while (evictions === 0 && atlas.pages.length <= budget && stormRounds < 120) {
        let chunk = ''
        for (let i = 0; i < 400; i += 1) {
          chunk += `\x1b[38;5;${16 + (nextCodePoint % 216)}m${String.fromCodePoint(nextCodePoint++)}`
          if (i % 50 === 49) {
            chunk += '\r\n'
          }
        }
        await write(A.terminal, `${chunk}\x1b[0m\r\n`)
        render(A.terminal)
        maxPages = Math.max(maxPages, atlas.pages.length)
        stormRounds += 1
      }
      const stormEvictions = evictions
      const unbindableGlyphs = (): number =>
        atlas.pages.slice(budget).reduce((count, atlasPage) => count + atlasPage._glyphs.length, 0)
      const pagesAfterStorm = atlas.pages.length
      const unbindableAfterStorm = unbindableGlyphs()
      const line = 'The quick brown fox jumps over 0123456789 =[]{}<>'
      let content = ''
      for (let row = 0; row < options.rows - 1; row += 1) {
        content += `${line}\r\n`
      }
      await write(B.terminal, content)
      render(B.terminal)
      const captureHeight = B.addon._renderer.dimensions.device.cell.height * (options.rows - 1) - 4
      const baseline = capture(B.addon, captureHeight)
      const baselineInkPixels = pixelsDifferentFromFirst(baseline)
      A.addon.clearTextureAtlas()
      const pagesAfterWipe = atlas.pages.length
      render(A.terminal)
      render(B.terminal)
      const afterWipe = capture(B.addon, captureHeight)
      return {
        baselineInkPixels,
        budget,
        evictions,
        maxPages,
        pagesAfterStorm,
        pagesAfterWipe,
        pixelDiffAfterWipe: pixelDiff(afterWipe, baseline),
        realBudget,
        shared,
        stormEvictions,
        stormRounds,
        unbindableAfterStorm,
        unbindableAfterWipe: unbindableGlyphs()
      }
    } finally {
      terminalA?.dispose()
      terminalB?.dispose()
      AtlasCtor.maxAtlasPages = realBudget
      AtlasCtor.maxTextureSize = realMaxTextureSize
      host.remove()
    }
  })
}

test.describe('terminal WebGL atlas budget', () => {
  test.describe.configure({ timeout: 120_000 })

  test('keeps shared glyph pages bindable through overflow and recovery @terminal-rendering-golden', async ({
    orcaPage
  }) => {
    await waitForActiveTerminalManager(orcaPage)
    test.skip(!(await forceActivePaneWebgl(orcaPage)), 'WebGL unavailable in this environment')
    const result = await runAtlasBudgetScenario(orcaPage)

    expect(result.realBudget).toBeGreaterThanOrEqual(result.budget)
    expect(result.shared).toBe(true)
    expect(result.stormRounds).toBeLessThan(120)
    expect(result.stormEvictions).toBeGreaterThan(0)
    expect(result.maxPages).toBeLessThanOrEqual(result.budget)
    expect(result.pagesAfterStorm).toBeLessThanOrEqual(result.budget)
    expect(result.unbindableAfterStorm).toBe(0)
    expect(result.pagesAfterWipe).toBe(1)
    expect(result.unbindableAfterWipe).toBe(0)
    expect(result.baselineInkPixels).toBeGreaterThan(1000)
    expect(result.pixelDiffAfterWipe).toBe(0)
  })
})
