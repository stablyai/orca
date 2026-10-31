import { writeFile } from 'node:fs/promises'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getActiveTabId, getActiveWorktreeId, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { captureStableTabScreenshot } from './terminal-tab-screenshot'
import { compareTerminalScreenshots } from './terminal-screenshot-diff'

// #7614: delayed IntersectionObserver leaves RenderService paused; refresh latches _needsFullRefresh but swallows repaint after atlas clear.
// Force that gate deterministically on real xterm: old refresh must render nothing, production atlas-reset/full-present must clear pause and repaint pixels.
// Hidden Electron cannot reliably race observer lag, so only _isPaused and render recording are test instrumentation.

const BOTTOM_MARKER = 'REVEAL_PAUSED_RENDER_BOTTOM_MARKER'

type RenderProbeResult = {
  paused: boolean
  renderedRanges: [number, number][]
  rows: number
}

type RevealRenderDebug = {
  installProbe: () => boolean
  setPaused: (paused: boolean) => boolean
  dirtyModelLikeReveal: () => boolean
  plainRefresh: () => void
  runRealRevealRepaint: () => void
  read: () => RenderProbeResult
}

type RevealProbeWindow = Window & {
  __revealRenderProbe?: RevealRenderDebug
  __syncRevealProbe?: {
    paintFrame: (marker: string, background: number, release: boolean) => Promise<void>
    forceRendererPresent: () => void
    read: () => {
      atlasClears: number
      fullViewportRenderRows: number
      screen: string
      synchronizedOutput: boolean
    }
  }
}

// Instrument production RenderService; manually pause to model observer lag and wrap _renderRows to record effects.
async function installRevealRenderProbe(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!manager || !pane) {
      throw new Error('No active pane for reveal render probe')
    }

    type PausableRenderService = {
      _isPaused?: boolean
      _needsFullRefresh?: boolean
      _renderRows?: (start: number, end: number) => void
      __revealProbeRanges?: [number, number][]
      __revealProbeInstalled?: boolean
    }
    type TerminalInternals = {
      rows?: number
      _core?: { _renderService?: PausableRenderService }
      buffer?: { active?: { getLine?: (y: number) => unknown } }
      refresh?: (start: number, end: number) => void
    }

    const terminal = pane.terminal as unknown as TerminalInternals
    const service = terminal._core?._renderService
    if (!service || typeof service._renderRows !== 'function') {
      throw new Error('Real RenderService._renderRows unavailable — cannot probe')
    }

    const debug: RevealRenderDebug = {
      installProbe: () => {
        if (service.__revealProbeInstalled) {
          service.__revealProbeRanges = []
          return true
        }
        service.__revealProbeRanges = []
        const original = service._renderRows!.bind(service)
        service._renderRows = (start: number, end: number): void => {
          service.__revealProbeRanges!.push([start, end])
          original(start, end)
        }
        service.__revealProbeInstalled = true
        return true
      },
      setPaused: (paused: boolean) => {
        service._isPaused = paused
        return service._isPaused === paused
      },
      dirtyModelLikeReveal: () => {
        // Atlas clear empties the render model and requests the redraw the paused gate swallows.
        const withAtlas = pane as unknown as {
          webglAddon?: { clearTextureAtlas?: () => void }
        }
        withAtlas.webglAddon?.clearTextureAtlas?.()
        return true
      },
      plainRefresh: () => {
        const rows = terminal.rows ?? 0
        terminal.refresh?.(0, Math.max(0, rows - 1))
      },
      runRealRevealRepaint: () => {
        manager.resetWebglTextureAtlases()
      },
      read: () => ({
        paused: service._isPaused === true,
        renderedRanges: (service.__revealProbeRanges ?? []).slice(),
        rows: terminal.rows ?? 0
      })
    }

    ;(window as RevealProbeWindow).__revealRenderProbe = debug
  }, tabId)
}

async function probeRead(page: Page): Promise<RenderProbeResult> {
  return page.evaluate(() => {
    const probe = (window as RevealProbeWindow).__revealRenderProbe
    if (!probe) {
      throw new Error('Reveal render probe not installed')
    }
    return probe.read()
  })
}

async function probeCall(
  page: Page,
  method:
    | 'installProbe'
    | 'setPaused'
    | 'dirtyModelLikeReveal'
    | 'plainRefresh'
    | 'runRealRevealRepaint',
  paused?: boolean
): Promise<void> {
  await page.evaluate(
    ({ method, paused }) => {
      const probe = (window as RevealProbeWindow).__revealRenderProbe
      if (!probe) {
        throw new Error('Reveal render probe not installed')
      }
      if (method === 'setPaused') {
        probe.setPaused(paused ?? false)
        return
      }
      ;(probe[method] as () => void)()
    },
    { method, paused }
  )
}

async function forceWebglOn(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    if (state?.settings) {
      window.__store?.setState({
        settings: { ...state.settings, terminalGpuAcceleration: 'on' }
      })
    }
    window.__paneManagers?.get(id)?.setTerminalGpuAcceleration?.('on')
  }, tabId)
}

async function installSynchronizedRevealProbe(page: Page, tabId: string): Promise<boolean> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = [
      ...((manager as unknown as { panes?: Map<number, unknown> } | undefined)?.panes?.values() ??
        [])
    ][0] as
      | {
          serializeAddon?: { serialize?: () => string }
          terminal: unknown
          webglAddon?: unknown
        }
      | undefined
    const addon = pane?.webglAddon as { clearTextureAtlas: () => void } | null | undefined
    type SyncRenderService = {
      _renderer?:
        | { renderRows?: (start: number, end: number) => void }
        | { value?: { renderRows?: (start: number, end: number) => void } | null }
      _syncOutputHandler?: { _timeout?: number }
    }
    const terminal = pane?.terminal as
      | {
          cols: number
          rows: number
          write: (data: string, callback: () => void) => void
          _core?: {
            coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
            _coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
            _renderService?: SyncRenderService
          }
        }
      | undefined
    const service = terminal?._core?._renderService
    const modes =
      terminal?._core?.coreService?.decPrivateModes ??
      terminal?._core?._coreService?.decPrivateModes
    const rendererHolder = service?._renderer
    const renderer =
      rendererHolder && 'renderRows' in rendererHolder
        ? rendererHolder
        : rendererHolder && 'value' in rendererHolder
          ? rendererHolder.value
          : null
    if (!pane || !addon || !terminal || !service || !modes || !renderer?.renderRows) {
      throw new Error(
        JSON.stringify({
          addon: Boolean(addon),
          modes: Boolean(modes),
          pane: Boolean(pane),
          renderer: Boolean(renderer?.renderRows),
          rendererKeys: rendererHolder ? Object.keys(rendererHolder) : [],
          service: Boolean(service),
          terminal: Boolean(terminal)
        })
      )
    }

    let atlasClears = 0
    let fullViewportRenderRows = 0
    const originalClear = addon.clearTextureAtlas.bind(addon)
    addon.clearTextureAtlas = () => {
      atlasClears += 1
      originalClear()
    }
    const originalRenderRows = renderer.renderRows.bind(renderer)
    renderer.renderRows = (start: number, end: number) => {
      if (start === 0 && end >= terminal.rows - 1) {
        fullViewportRenderRows += 1
      }
      originalRenderRows(start, end)
    }

    const paintFrame = (marker: string, background: number, release: boolean): Promise<void> => {
      const width = Math.max(1, terminal.cols)
      const rows = Math.max(1, terminal.rows)
      const line = ` ${marker} `.padEnd(width, marker[0] ?? '#').slice(0, width)
      const frame = Array.from(
        { length: rows },
        (_, row) => `\x1b[${row + 1};1H\x1b[48;5;${background}m\x1b[38;5;231m${line}`
      ).join('')
      return new Promise((resolve) => {
        terminal.write(
          `\x1b[?2026h\x1b[?1049h\x1b[2J${frame}\x1b[0m${release ? '\x1b[?2026l' : ''}`,
          () => {
            if (!release && service._syncOutputHandler?._timeout !== undefined) {
              window.clearTimeout(service._syncOutputHandler._timeout)
              service._syncOutputHandler._timeout = undefined
            }
            resolve()
          }
        )
      })
    }

    ;(window as RevealProbeWindow).__syncRevealProbe = {
      paintFrame,
      forceRendererPresent: () => renderer.renderRows?.(0, terminal.rows - 1),
      read: () => ({
        atlasClears,
        fullViewportRenderRows,
        screen: pane.serializeAddon?.serialize?.() ?? '',
        synchronizedOutput: modes.synchronizedOutput === true
      })
    }
    return true
  }, tabId)
}

async function callSynchronizedRevealProbe(
  page: Page,
  action: 'forceRendererPresent' | 'paintFrame',
  frame?: { marker: string; background: number; release: boolean }
): Promise<void> {
  await page.evaluate(
    async ({ action, frame }) => {
      const probe = (window as RevealProbeWindow).__syncRevealProbe
      if (!probe) {
        throw new Error('Synchronized reveal probe not installed')
      }
      if (action === 'paintFrame') {
        if (!frame) {
          throw new Error('Synchronized frame missing')
        }
        await probe.paintFrame(frame.marker, frame.background, frame.release)
        return
      }
      probe.forceRendererPresent()
    },
    { action, frame }
  )
}

async function readSynchronizedRevealProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (window as RevealProbeWindow).__syncRevealProbe
    if (!probe) {
      throw new Error('Synchronized reveal probe not installed')
    }
    return probe.read()
  })
}

async function captureFirstRevealedFrame(page: Page, tabId: string): Promise<Buffer> {
  const screen = page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-screen`).first()
  await expect(screen).toBeVisible()
  return screen.screenshot({ animations: 'disabled' })
}

test.describe('terminal reveal paused-render recovery', () => {
  test("reveal repaint forces a render through xterm's paused gate", async ({ orcaPage }) => {
    // Use orcaPage: the main renderer owns __store/__paneManagers, unlike Playwright’s first page.
    const page = orcaPage
    await waitForSessionReady(page)
    await waitForActiveTerminalManager(page)
    const tabId = (await getActiveTabId(page))!
    const ptyId = await waitForActivePanePtyId(page)

    await forceWebglOn(page, tabId)

    // Fill bottom rows so swallowed repaint affects both render ranges and pixels.
    await execInTerminal(
      page,
      ptyId,
      `for i in $(seq 1 40); do echo "line $i ${BOTTOM_MARKER}_$i"; done`
    )
    await waitForTerminalOutput(page, `${BOTTOM_MARKER}_40`)
    await execInTerminal(
      page,
      ptyId,
      `clear; printf '%s\\n' "$(seq 1 30)"; echo "${BOTTOM_MARKER}_FINAL"`
    )
    await waitForTerminalOutput(page, `${BOTTOM_MARKER}_FINAL`)

    const revealed = await captureStableTabScreenshot(page, tabId)

    await installRevealRenderProbe(page, tabId)
    await probeCall(page, 'installProbe')

    // Control replays pre-fix origin/main’s clearTextureAtlas+refresh while paused; it must render nothing.
    await probeCall(page, 'setPaused', true)
    await probeCall(page, 'dirtyModelLikeReveal')
    await probeCall(page, 'plainRefresh')
    await page.waitForTimeout(80)
    const afterPlainRefresh = await probeRead(page)

    expect(afterPlainRefresh.paused, 'terminal is in the paused-render state').toBe(true)
    expect(
      afterPlainRefresh.renderedRanges,
      'BUG REPRODUCED: while paused, plain refresh() is swallowed by the gate — no render fires'
    ).toHaveLength(0)

    await probeCall(page, 'setPaused', true)
    await probeCall(page, 'dirtyModelLikeReveal')
    await probeCall(page, 'runRealRevealRepaint')
    await page.waitForTimeout(80)
    const afterRealReveal = await probeRead(page)

    expect(
      afterRealReveal.renderedRanges.length,
      'FIX: reveal repaint drove at least one render despite the paused gate'
    ).toBeGreaterThan(0)

    const fullViewportRender = afterRealReveal.renderedRanges.some(
      ([start, end]) => start === 0 && end >= afterRealReveal.rows - 1
    )
    expect(
      fullViewportRender,
      'FIX: reveal repaint rendered the FULL viewport (0..rows-1), not a partial range'
    ).toBe(true)

    expect(
      afterRealReveal.paused,
      'FIX: pause latch is cleared so the observer can reassert authority cleanly'
    ).toBe(false)

    const afterFix = await captureStableTabScreenshot(page, tabId)
    const diff = compareTerminalScreenshots(revealed, afterFix)
    expect(
      diff.matches,
      `recovered surface matches the revealed content (diffRatio=${diff.diffRatio})`
    ).toBe(true)
  })

  test('@headful atlas recovery keeps the coherent frame until synchronized output releases', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const tabId = (await getActiveTabId(orcaPage))!
    await forceWebglOn(orcaPage, tabId)
    const webglAttached = await orcaPage
      .waitForFunction(
        (tabId) =>
          (window.__paneManagers?.get(tabId)?.getRenderingDiagnostics?.() ?? []).some(
            (diagnostic) => diagnostic.hasWebgl
          ),
        tabId,
        { timeout: 15_000 }
      )
      .then(() => true)
      .catch(() => false)
    test.skip(!webglAttached, 'WebGL renderer is unavailable')
    if (!webglAttached) {
      return
    }
    const installed = await installSynchronizedRevealProbe(orcaPage, tabId)
    expect(installed, 'WebGL renderer internals are available').toBe(true)

    await callSynchronizedRevealProbe(orcaPage, 'paintFrame', {
      marker: 'BASELINE_FRAME',
      background: 17,
      release: true
    })
    const baseline = await captureStableTabScreenshot(orcaPage, tabId)
    await callSynchronizedRevealProbe(orcaPage, 'paintFrame', {
      marker: 'REVEALED_FRAME',
      background: 52,
      release: false
    })
    const held = await readSynchronizedRevealProbe(orcaPage)
    expect(held.synchronizedOutput).toBe(true)
    expect(held.screen).toContain('REVEALED_FRAME')

    await orcaPage.evaluate((tabId) => {
      window.__paneManagers?.get(tabId)?.scheduleRevealRepaint()
    }, tabId)
    await expect
      .poll(async () => (await readSynchronizedRevealProbe(orcaPage)).atlasClears)
      .toBeGreaterThan(0)
    // Why not a stable capture: the atlas clear's redraw starts xterm's 1s DEC 2026 safety timeout.
    const afterReveal = await captureFirstRevealedFrame(orcaPage, tabId)
    const heldDiff = compareTerminalScreenshots(baseline, afterReveal)

    await callSynchronizedRevealProbe(orcaPage, 'paintFrame', {
      marker: 'REVEALED_FRAME',
      background: 52,
      release: true
    })
    const released = await captureStableTabScreenshot(orcaPage, tabId)
    await callSynchronizedRevealProbe(orcaPage, 'forceRendererPresent')
    const direct = await captureStableTabScreenshot(orcaPage, tabId)
    const releasedDiff = compareTerminalScreenshots(released, direct)
    const afterRevealPath = testInfo.outputPath('synchronized-frame-after-reveal.png')
    const releasedPath = testInfo.outputPath('synchronized-frame-after-release.png')
    const pixelDiffPath = testInfo.outputPath('synchronized-frame-pixel-diff.json')
    await Promise.all([
      writeFile(afterRevealPath, afterReveal),
      writeFile(releasedPath, released),
      writeFile(pixelDiffPath, JSON.stringify({ heldDiff, releasedDiff }, null, 2))
    ])
    for (const [name, path, contentType] of [
      ['synchronized-frame-after-reveal.png', afterRevealPath, 'image/png'],
      ['synchronized-frame-after-release.png', releasedPath, 'image/png'],
      ['synchronized-frame-pixel-diff.json', pixelDiffPath, 'application/json']
    ] as const) {
      await testInfo.attach(name, { path, contentType })
    }
    expect(
      heldDiff.matches,
      `atlas recovery keeps the coherent frame while DEC 2026 is held (diffRatio=${heldDiff.diffRatio})`
    ).toBe(true)
    expect(
      compareTerminalScreenshots(baseline, released).matches,
      'release replaces the coherent frame'
    ).toBe(false)
    expect(
      releasedDiff.matches,
      `release presents the completed frame (diffRatio=${releasedDiff.diffRatio})`
    ).toBe(true)
  })

  test('@headful reveal preserves the coherent frame until synchronized output releases', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const tabId = (await getActiveTabId(orcaPage))!
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await forceWebglOn(orcaPage, tabId)
    const webglAttached = await orcaPage
      .waitForFunction(
        (tabId) =>
          (window.__paneManagers?.get(tabId)?.getRenderingDiagnostics?.() ?? []).some(
            (diagnostic) => diagnostic.hasWebgl
          ),
        tabId,
        { timeout: 15_000 }
      )
      .then(() => true)
      .catch(() => false)
    test.skip(!webglAttached, 'WebGL renderer is unavailable')
    if (!webglAttached) {
      return
    }
    expect(await installSynchronizedRevealProbe(orcaPage, tabId)).toBe(true)

    await callSynchronizedRevealProbe(orcaPage, 'paintFrame', {
      marker: 'COHERENT_FRAME',
      background: 17,
      release: true
    })
    const coherent = await captureStableTabScreenshot(orcaPage, tabId)
    const beforeHide = await readSynchronizedRevealProbe(orcaPage)
    const siblingTabId = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Renderer store unavailable')
      }
      return state.createTab(worktreeId, undefined, undefined, { activate: false }).id
    }, worktreeId)
    await orcaPage.evaluate(
      (siblingTabId) => window.__store?.getState().setActiveTab(siblingTabId),
      siblingTabId
    )
    await expect(orcaPage.locator(`[data-terminal-tab-id="${tabId}"]`)).toBeHidden()

    await callSynchronizedRevealProbe(orcaPage, 'paintFrame', {
      marker: 'PENDING_FRAME',
      background: 52,
      release: false
    })
    await orcaPage.evaluate((tabId) => window.__store?.getState().setActiveTab(tabId), tabId)
    await expect.poll(() => getActiveTabId(orcaPage)).toBe(tabId)
    const held = await captureFirstRevealedFrame(orcaPage, tabId)
    const heldState = await readSynchronizedRevealProbe(orcaPage)
    const heldDiff = compareTerminalScreenshots(coherent, held)

    expect(heldState.synchronizedOutput).toBe(true)
    expect(heldState.screen).toContain('PENDING_FRAME')
    expect(heldState.atlasClears - beforeHide.atlasClears, 'ordinary reveal atlas clears').toBe(0)
    expect(
      heldDiff.matches,
      `held reveal preserves the coherent frame (diffRatio=${heldDiff.diffRatio})`
    ).toBe(true)

    await callSynchronizedRevealProbe(orcaPage, 'paintFrame', {
      marker: 'PENDING_FRAME',
      background: 52,
      release: true
    })
    const released = await captureStableTabScreenshot(orcaPage, tabId)
    const releaseState = await readSynchronizedRevealProbe(orcaPage)
    await callSynchronizedRevealProbe(orcaPage, 'forceRendererPresent')
    const direct = await captureStableTabScreenshot(orcaPage, tabId)
    const releasedDiff = compareTerminalScreenshots(released, direct)

    await callSynchronizedRevealProbe(orcaPage, 'paintFrame', {
      marker: 'WATCHDOG_FRAME',
      background: 88,
      release: false
    })
    const beforeWatchdog = await readSynchronizedRevealProbe(orcaPage)
    await orcaPage.evaluate((tabId) => {
      window.__paneManagers?.get(tabId)?.scheduleRevealPresent()
    }, tabId)
    await expect
      .poll(async () => (await readSynchronizedRevealProbe(orcaPage)).synchronizedOutput, {
        timeout: 2_500
      })
      .toBe(false)
    const watchdog = await captureStableTabScreenshot(orcaPage, tabId)
    const watchdogState = await readSynchronizedRevealProbe(orcaPage)
    await callSynchronizedRevealProbe(orcaPage, 'forceRendererPresent')
    const watchdogDirect = await captureStableTabScreenshot(orcaPage, tabId)
    const watchdogDiff = compareTerminalScreenshots(watchdog, watchdogDirect)
    const coherentPath = testInfo.outputPath('synchronized-coherent-before-hide.png')
    const heldPath = testInfo.outputPath('synchronized-coherent-while-held.png')
    const releasedPath = testInfo.outputPath('synchronized-new-frame-after-release.png')
    const watchdogPath = testInfo.outputPath('synchronized-new-frame-after-watchdog.png')
    const metricsPath = testInfo.outputPath('synchronized-prevention-metrics.json')
    const counts = (state: Awaited<ReturnType<typeof readSynchronizedRevealProbe>>) => ({
      atlasClears: state.atlasClears,
      fullViewportRenderRows: state.fullViewportRenderRows,
      synchronizedOutput: state.synchronizedOutput
    })
    await Promise.all([
      writeFile(coherentPath, coherent),
      writeFile(heldPath, held),
      writeFile(releasedPath, released),
      writeFile(watchdogPath, watchdog),
      writeFile(
        metricsPath,
        JSON.stringify(
          {
            beforeHide: counts(beforeHide),
            heldState: counts(heldState),
            releaseState: counts(releaseState),
            beforeWatchdog: counts(beforeWatchdog),
            watchdogState: counts(watchdogState),
            heldDiff,
            releasedDiff,
            watchdogDiff
          },
          null,
          2
        )
      )
    ])
    for (const [name, path] of [
      ['synchronized-coherent-before-hide.png', coherentPath],
      ['synchronized-coherent-while-held.png', heldPath],
      ['synchronized-new-frame-after-release.png', releasedPath],
      ['synchronized-new-frame-after-watchdog.png', watchdogPath],
      ['synchronized-prevention-metrics.json', metricsPath]
    ] as const) {
      await testInfo.attach(name, {
        path,
        contentType: name.endsWith('.json') ? 'application/json' : 'image/png'
      })
    }
    expect(releaseState.synchronizedOutput).toBe(false)
    expect(
      releasedDiff.matches,
      `released frame matches a direct renderer present (diffRatio=${releasedDiff.diffRatio})`
    ).toBe(true)
    expect(watchdogState.atlasClears - beforeWatchdog.atlasClears).toBe(0)
    expect(
      watchdogDiff.matches,
      `watchdog frame matches a direct renderer present (diffRatio=${watchdogDiff.diffRatio})`
    ).toBe(true)
  })
})
