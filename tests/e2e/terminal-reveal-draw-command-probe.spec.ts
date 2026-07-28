/**
 * STA-2694 draw-command oracle.
 *
 * Every pixel-level oracle tried for this bug was blind: `drawImage` on a
 * non-`preserveDrawingBuffer` WebGL canvas returns a re-rendered copy, and
 * Playwright's screenshot drives a fresh compositor frame that heals a stale
 * paint before capture. This spec sidesteps pixels entirely and counts the
 * WebGL draw commands the repaint actually issues, by wrapping
 * `GlyphRenderer.updateCell` and `gl.drawElementsInstanced` on the live pane.
 *
 * A draw command cannot be healed after the fact, so "did the reveal repaint?"
 * becomes directly observable — and falsifiable, which is how this spec refuted
 * one hypothesis outright (see the first test).
 */
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

type DrawStats = {
  updateCellCalls: number
  drawCalls: number
  instancesDrawn: number
  rows: number
  cols: number
}

type RendererGeometry = {
  canvasWidth: number
  canvasHeight: number
  modelCanvasWidth: number
  modelCanvasHeight: number
  charWidth: number
  charHeight: number
  isAttached: boolean
  synchronizedOutput: boolean
  isPaused: boolean
  atlasPageVersions: number[]
  boundTextureVersions: number[]
  screenConnected: boolean
}

async function setUpWebglPane(page: Page): Promise<boolean> {
  await waitForSessionReady(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.settings) {
      throw new Error('Store unavailable')
    }
    window.__store?.setState({
      settings: { ...state.settings, terminalGpuAcceleration: 'on' }
    })
    for (const manager of window.__paneManagers?.values() ?? []) {
      ;(
        manager as { setTerminalGpuAcceleration?: (mode: string) => void }
      ).setTerminalGpuAcceleration?.('on')
    }
  })
  const gotWebgl = await page
    .waitForFunction(
      () => {
        for (const manager of window.__paneManagers?.values() ?? []) {
          const diagnostics =
            (
              manager as { getRenderingDiagnostics?: () => { hasWebgl: boolean }[] }
            ).getRenderingDiagnostics?.() ?? []
          if (diagnostics.some((diagnostic) => diagnostic.hasWebgl)) {
            return true
          }
        }
        return false
      },
      { timeout: 20_000 }
    )
    .then(() => true)
    .catch(() => false)
  if (!gotWebgl) {
    return false
  }
  // Stable text so lineLengths (and therefore drawn instances) are non-zero.
  await page.evaluate(() => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of (manager as { getPanes?: () => unknown[] }).getPanes?.() ?? []) {
        const terminal = (pane as { terminal?: { write?: (data: string) => void } }).terminal
        terminal?.write?.(`${'STA2694-PROBE '.repeat(40)}\r\n`)
      }
    }
  })
  await page.waitForTimeout(1_500)
  return true
}

/** Wraps updateCell + drawElementsInstanced on the live pane's WebGL renderer. */
async function instrumentDrawCommands(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as {
      __paneManagers?: Map<string, { getPanes?: () => unknown[] }>
      __drawProbe?: unknown
    }
    // getPanes() returns a public view without webglAddon, so reach the live
    // renderer through the render service instead.
    let renderer: Record<string, unknown> | null = null
    for (const manager of win.__paneManagers?.values() ?? []) {
      for (const candidate of manager.getPanes?.() ?? []) {
        const active = (
          candidate as {
            terminal?: { _core?: { _renderService?: { _renderer?: { value?: unknown } } } }
          }
        ).terminal?._core?._renderService?._renderer?.value as Record<string, unknown> | undefined
        if (active?._gl) {
          renderer = active
        }
      }
    }
    if (!renderer) {
      throw new Error('no WebGL pane to instrument')
    }
    const glyphRenderer = (renderer._glyphRenderer as { value?: Record<string, unknown> })?.value
    if (!glyphRenderer) {
      throw new Error('renderer has no glyph renderer')
    }
    const gl = renderer._gl as WebGL2RenderingContext
    const probe = {
      updateCellCalls: 0,
      drawCalls: 0,
      instancesDrawn: 0,
      reset(): void {
        probe.updateCellCalls = 0
        probe.drawCalls = 0
        probe.instancesDrawn = 0
      }
    }
    win.__drawProbe = probe

    const originalUpdateCell = glyphRenderer.updateCell as (...args: unknown[]) => unknown
    glyphRenderer.updateCell = function patched(...args: unknown[]): unknown {
      probe.updateCellCalls++
      return originalUpdateCell.apply(this, args)
    }
    const originalDraw = gl.drawElementsInstanced.bind(gl)
    gl.drawElementsInstanced = function patched(
      mode: number,
      count: number,
      type: number,
      offset: number,
      instanceCount: number
    ): void {
      probe.drawCalls++
      probe.instancesDrawn += instanceCount
      originalDraw(mode, count, type, offset, instanceCount)
    }
  })
}

type RefreshOptions = { clearModel?: boolean; latchSynchronizedOutput?: boolean }

async function forceRefreshAndRead(page: Page, options: RefreshOptions = {}): Promise<DrawStats> {
  return page.evaluate((opts) => {
    const win = window as unknown as {
      __paneManagers?: Map<string, { getPanes?: () => unknown[] }>
      __drawProbe?: {
        updateCellCalls: number
        drawCalls: number
        instancesDrawn: number
        reset: () => void
      }
    }
    let found: unknown = null
    for (const manager of win.__paneManagers?.values() ?? []) {
      for (const candidate of manager.getPanes?.() ?? []) {
        const candidateTerminal = (
          candidate as {
            terminal?: {
              _core?: { _renderService?: { _renderer?: { value?: { _gl?: unknown } } } }
            }
          }
        ).terminal
        if (candidateTerminal?._core?._renderService?._renderer?.value?._gl) {
          found = candidateTerminal
        }
      }
    }
    const terminal = found as
      | {
          rows: number
          cols: number
          _core?: {
            coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
            _renderService?: {
              clear?: () => void
              refreshRows?: (s: number, e: number, sync?: boolean) => void
            }
          }
        }
      | undefined
    const probe = win.__drawProbe
    if (!terminal || !probe) {
      throw new Error('probe or terminal missing')
    }
    if (opts.clearModel) {
      terminal._core?._renderService?.clear?.()
    }
    const modes = terminal._core?.coreService?.decPrivateModes
    if (opts.latchSynchronizedOutput && modes) {
      modes.synchronizedOutput = true
    }
    probe.reset()
    // Synchronous refresh so the counters are populated before we read them.
    terminal._core?._renderService?.refreshRows?.(0, terminal.rows - 1, true)
    return {
      updateCellCalls: probe.updateCellCalls,
      drawCalls: probe.drawCalls,
      instancesDrawn: probe.instancesDrawn,
      rows: terminal.rows,
      cols: terminal.cols
    }
  }, options)
}

async function readRendererGeometry(page: Page): Promise<RendererGeometry> {
  return page.evaluate(() => {
    let renderer: Record<string, unknown> | null = null
    let terminal: Record<string, unknown> | null = null
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const candidate of (manager as { getPanes?: () => unknown[] }).getPanes?.() ?? []) {
        const candidateTerminal = (candidate as { terminal?: Record<string, unknown> }).terminal
        const active = (
          candidateTerminal as
            | { _core?: { _renderService?: { _renderer?: { value?: Record<string, unknown> } } } }
            | undefined
        )?._core?._renderService?._renderer?.value
        if (active?._gl) {
          renderer = active
          terminal = candidateTerminal as Record<string, unknown>
        }
      }
    }
    if (!renderer || !terminal) {
      throw new Error('no WebGL pane')
    }
    const canvas = renderer._canvas as HTMLCanvasElement
    const dimensions = renderer.dimensions as {
      device: { canvas: { width: number; height: number } }
    }
    const charSizeService = renderer._charSizeService as { width: number; height: number }
    const core = terminal._core as {
      screenElement?: HTMLElement
      coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
      _renderService?: { _isPaused?: boolean }
    }
    const atlas = renderer._charAtlas as { pages?: { version: number }[] } | undefined
    const glyphRenderer = (renderer._glyphRenderer as { value?: Record<string, unknown> })?.value
    const boundTextures = (glyphRenderer?._atlasTextures as { version: number }[] | undefined) ?? []
    return {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      modelCanvasWidth: dimensions.device.canvas.width,
      modelCanvasHeight: dimensions.device.canvas.height,
      charWidth: charSizeService.width,
      charHeight: charSizeService.height,
      isAttached: Boolean(renderer._isAttached),
      synchronizedOutput: Boolean(core.coreService?.decPrivateModes?.synchronizedOutput),
      isPaused: Boolean(core._renderService?._isPaused),
      atlasPageVersions: (atlas?.pages ?? []).map((page) => page.version),
      boundTextureVersions: boundTextures.map((texture) => texture?.version ?? -1),
      screenConnected: Boolean(core.screenElement?.isConnected)
    }
  })
}

test.describe('reveal draw-command oracle (STA-2694)', () => {
  // REFUTATION TEST. The hypothesis was: xterm's renderers are diff-based, so a
  // reveal `refresh()` skips cells whose model entry still matches the buffer,
  // leaving an occluded canvas showing pre-hide pixels until a resize rebuilds
  // the model. `_updateModel` really does early-continue per unchanged cell —
  // but `GlyphRenderer.render` then copies vertices for EVERY row up to
  // `lineLengths[y]` and issues ONE full-viewport `drawElementsInstanced`. So
  // the diff only decides how much VERTEX data is rewritten, never how much is
  // DRAWN. This test pins that, so the refuted hypothesis cannot be
  // reintroduced as a "fix".
  test('a diff-skipped refresh draws exactly as much as a model-cleared one', async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    test.skip(!(await setUpWebglPane(orcaPage)), 'WebGL renderer unavailable in this environment')
    await instrumentDrawCommands(orcaPage)

    // Model already matches the buffer, so every cell diff-skips.
    const warm = await forceRefreshAndRead(orcaPage)
    // Model cleared first, so every cell is re-sent through updateCell.
    const cleared = await forceRefreshAndRead(orcaPage, { clearModel: true })

    expect(warm.updateCellCalls, 'expected the warm pass to diff-skip its cells').toBe(0)
    expect(cleared.updateCellCalls, 'expected the cleared pass to re-send cells').toBeGreaterThan(0)
    // The decisive comparison: identical draw output despite a 0-vs-N split in
    // vertex updates. Clearing the model cannot change what reaches the screen.
    expect(warm.drawCalls, 'a diff-skipped refresh issued no draw at all').toBeGreaterThan(0)
    expect(
      warm.instancesDrawn,
      'a diff-skipped refresh drew fewer instances than a model-cleared one — ' +
        'the diff-based-staleness hypothesis would be back in play'
    ).toBe(cleared.instancesDrawn)
  })

  // The COST of clearing the render model, which the refutation above shows buys
  // nothing: `_clearModel(true)` zeroes every glyph vertex and resets
  // `lineLengths`, and `RenderService.clear()` fires no repaint of its own. So
  // any paint that lands between the clear and the repopulating refresh draws an
  // EMPTY viewport. On a reveal the following refresh is debounced through a RAF
  // and can additionally be swallowed (paused render, latched synchronized
  // output), which would turn a merely-stale pane into a blank one.
  test('clearing the render model without repopulating it draws an empty viewport', async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    test.skip(!(await setUpWebglPane(orcaPage)), 'WebGL renderer unavailable in this environment')
    await instrumentDrawCommands(orcaPage)

    const populated = await forceRefreshAndRead(orcaPage)
    expect(populated.instancesDrawn, 'baseline drew nothing').toBeGreaterThan(0)

    // Clear the model, then draw WITHOUT letting _updateModel repopulate it —
    // exactly the window a debounced or swallowed refresh leaves open.
    const blank = await orcaPage.evaluate(() => {
      const win = window as unknown as {
        __paneManagers?: Map<string, { getPanes?: () => unknown[] }>
        __drawProbe?: { instancesDrawn: number; drawCalls: number; reset: () => void }
      }
      let renderer: Record<string, unknown> | null = null
      let model: unknown = null
      for (const manager of win.__paneManagers?.values() ?? []) {
        for (const candidate of manager.getPanes?.() ?? []) {
          const active = (
            candidate as {
              terminal?: { _core?: { _renderService?: { _renderer?: { value?: unknown } } } }
            }
          ).terminal?._core?._renderService?._renderer?.value as Record<string, unknown> | undefined
          if (active?._gl) {
            renderer = active
            model = active._model
          }
        }
      }
      const glyphRenderer = (renderer?._glyphRenderer as { value?: Record<string, unknown> })?.value
      const probe = win.__drawProbe
      if (!renderer || !glyphRenderer || !probe) {
        throw new Error('probe or renderer missing')
      }
      // What RenderService.clear() does to the renderer.
      ;(renderer.clear as () => void).call(renderer)
      probe.reset()
      // Draw the cleared model directly, skipping _updateModel.
      ;(glyphRenderer.render as (m: unknown) => void).call(glyphRenderer, model)
      return { instancesDrawn: probe.instancesDrawn, drawCalls: probe.drawCalls }
    })

    expect(
      blank.instancesDrawn,
      'a cleared model still drew content — the blank-pane window would not exist'
    ).toBe(0)
    // Restore the pane so the fixture teardown sees a painted terminal.
    await forceRefreshAndRead(orcaPage, { clearModel: true })
  })

  // The mechanism that IS real: while a TUI's synchronized-output frame is
  // latched, RenderService returns before reaching the renderer, so a repaint
  // draws literally nothing. Counting draw commands proves it directly instead
  // of inferring it from pixels.
  test('a latched synchronized-output frame drops the repaint entirely', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    test.skip(!(await setUpWebglPane(orcaPage)), 'WebGL renderer unavailable in this environment')
    await instrumentDrawCommands(orcaPage)

    const baseline = await forceRefreshAndRead(orcaPage)
    expect(baseline.drawCalls, 'baseline refresh drew nothing').toBeGreaterThan(0)

    // Hide mid-`?2026h`: the latch stays set and every repaint is swallowed.
    const latched = await forceRefreshAndRead(orcaPage, { latchSynchronizedOutput: true })
    expect(
      latched.drawCalls,
      'a latched synchronized-output frame should swallow the repaint completely'
    ).toBe(0)

    // What the production fix does at both reveal repaint entry points.
    const released = await orcaPage.evaluate(() => {
      let invoked = 0
      for (const manager of window.__paneManagers?.values() ?? []) {
        const schedule = (manager as { scheduleRevealPresent?: () => void }).scheduleRevealPresent
        if (typeof schedule === 'function') {
          schedule.call(manager)
          invoked++
        }
      }
      return invoked
    })
    // Why count rather than assume: scheduleRevealPresent is optional-chained,
    // so a missing test hook would otherwise surface below as "the fix did not
    // release the latch" and misattribute the failure to production code.
    expect(released, 'no pane manager exposed scheduleRevealPresent').toBeGreaterThan(0)
    await orcaPage.waitForTimeout(500)

    const afterRelease = await forceRefreshAndRead(orcaPage)
    expect(
      afterRelease.drawCalls,
      'the reveal repaint left the latch set, so the pane still cannot paint'
    ).toBeGreaterThan(0)
  })

  // The indefinite-garble case, and the reason the 1s watchdog does NOT bound
  // it. `refreshRows` checks `_isPaused` BEFORE the synchronized-output latch
  // and returns early, so while a pane is occluded nothing ever reaches
  // `bufferRows` — which is the only place the watchdog arms. A pane hidden mid
  // `?2026h` therefore holds the latch with NO timer pending, and stays that way
  // until something clears the latch explicitly. That is unbounded, not 1s.
  test('an occluded pane strands a latched frame with no watchdog to clear it', async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    test.skip(!(await setUpWebglPane(orcaPage)), 'WebGL renderer unavailable in this environment')
    await instrumentDrawCommands(orcaPage)

    const stranded = await orcaPage.evaluate(() => {
      let terminal: Record<string, unknown> | null = null
      for (const manager of window.__paneManagers?.values() ?? []) {
        for (const candidate of (manager as { getPanes?: () => unknown[] }).getPanes?.() ?? []) {
          const candidateTerminal = (candidate as { terminal?: Record<string, unknown> }).terminal
          const active = (
            candidateTerminal as
              | { _core?: { _renderService?: { _renderer?: { value?: { _gl?: unknown } } } } }
              | undefined
          )?._core?._renderService?._renderer?.value
          if (active?._gl) {
            terminal = candidateTerminal as Record<string, unknown>
          }
        }
      }
      const core = terminal?._core as {
        coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
        _renderService?: {
          _isPaused?: boolean
          _syncOutputHandler?: { _timeout?: number; _isBuffering?: boolean }
          refreshRows?: (s: number, e: number, sync?: boolean) => void
        }
      }
      const service = core?._renderService
      const modes = core?.coreService?.decPrivateModes
      if (!service || !modes || !terminal) {
        throw new Error('render service unavailable')
      }
      // Exactly the field state: the TUI opened a frame, then the pane was
      // occluded (IntersectionObserver pauses rendering) before ?2026l arrived.
      modes.synchronizedOutput = true
      service._isPaused = true
      service.refreshRows?.(0, (terminal.rows as number) - 1, true)
      const armed = {
        watchdogPending: service._syncOutputHandler?._timeout !== undefined,
        buffering: service._syncOutputHandler?._isBuffering === true,
        latched: modes.synchronizedOutput === true
      }
      // Reveal: the pane intersects again and the pause lifts.
      service._isPaused = false
      return armed
    })

    expect(stranded.latched, 'the latch should still be set while occluded').toBe(true)
    // The decisive observation: no timer, so nothing will ever clear this latch.
    expect(
      stranded.watchdogPending,
      'a watchdog was armed, so the latch would self-clear in 1s and the window would be bounded'
    ).toBe(false)
    expect(stranded.buffering, 'the paused return happened before any row buffering').toBe(false)

    // A repaint now draws nothing, no matter how long the pane waits.
    const whileLatched = await forceRefreshAndRead(orcaPage)
    expect(whileLatched.drawCalls, 'expected the stranded latch to swallow the repaint').toBe(0)

    // The production fix, at the real reveal entry point.
    const invokedReveal = await orcaPage.evaluate(() => {
      let invoked = 0
      for (const manager of window.__paneManagers?.values() ?? []) {
        const schedule = (manager as { scheduleRevealPresent?: () => void }).scheduleRevealPresent
        if (typeof schedule === 'function') {
          schedule.call(manager)
          invoked++
        }
      }
      return invoked
    })
    expect(invokedReveal, 'no pane manager exposed scheduleRevealPresent').toBeGreaterThan(0)
    await orcaPage.waitForTimeout(600)

    const afterFix = await forceRefreshAndRead(orcaPage)
    expect(
      afterFix.drawCalls,
      'the reveal repaint did not release the stranded latch, so the pane stays frozen'
    ).toBeGreaterThan(0)
    expect(afterFix.instancesDrawn, 'the released repaint drew an empty viewport').toBeGreaterThan(
      0
    )
  })

  // Tests the remaining live hypothesis: that a hidden pane's canvas backing
  // store or char metrics go stale, so nothing re-runs handleResize() on
  // reveal and only a real window resize repairs the display.
  test('a hide/reveal cycle leaves canvas geometry and atlas bindings consistent', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    test.skip(!(await setUpWebglPane(orcaPage)), 'WebGL renderer unavailable in this environment')

    const before = await readRendererGeometry(orcaPage)
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.hide()
    })
    await orcaPage.waitForTimeout(4_000)
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.show()
      window?.focus()
    })
    await orcaPage.waitForTimeout(3_000)

    await instrumentDrawCommands(orcaPage)
    const afterReveal = await readRendererGeometry(orcaPage)
    const afterDraw = await forceRefreshAndRead(orcaPage)
    // Atlas page bindings are lazy: GlyphRenderer.render rebinds any page whose
    // version moved. So the binding must be judged AFTER a draw — a lag that a
    // render repairs on its own is normal, one that survives a render is not.
    const after = await readRendererGeometry(orcaPage)
    console.log('[probe] geometry before hide:', JSON.stringify(before))
    console.log('[probe] geometry right after reveal:', JSON.stringify(afterReveal))
    console.log('[probe] post-reveal draw:', JSON.stringify(afterDraw))
    console.log('[probe] geometry after a repaint:', JSON.stringify(after))

    // The canvas backing store must still match the dimensions the renderer
    // computes from the grid; a mismatch is exactly what a window resize fixes.
    expect(
      { width: after.canvasWidth, height: after.canvasHeight },
      `canvas backing store diverged from renderer dimensions after reveal: ${JSON.stringify(after)}`
    ).toEqual({ width: after.modelCanvasWidth, height: after.modelCanvasHeight })
    expect(after.charWidth, 'char width went stale/zero across the hide').toBeGreaterThan(0)
    expect(after.charHeight, 'char height went stale/zero across the hide').toBeGreaterThan(0)
    expect(after.isAttached, 'renderer detached across the hide and never re-attached').toBe(true)
    expect(after.screenConnected, 'screen element disconnected across the hide').toBe(true)
    expect(after.synchronizedOutput, 'synchronized output left latched after reveal').toBe(false)
    expect(after.isPaused, 'render service left paused after reveal').toBe(false)
    // A glyph page whose bound texture version still lags AFTER a repaint
    // renders stale/garbled glyphs — the shared-atlas half of the report.
    expect(
      after.boundTextureVersions.slice(0, after.atlasPageVersions.length),
      `bound atlas textures still lag the atlas pages after a full repaint: ${JSON.stringify(after)}`
    ).toEqual(after.atlasPageVersions)
    expect(afterDraw.drawCalls, 'the pane cannot draw at all after a reveal').toBeGreaterThan(0)
  })
})
