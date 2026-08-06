import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getActiveTabId, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { captureStableTabScreenshot } from './terminal-tab-screenshot'
import { compareTerminalScreenshots } from './terminal-screenshot-diff'

/**
 * Reproduction for the "missing bottom rows on reveal, recover on drag-select"
 * bug (PR #7614). The mechanism is xterm's RenderService gating refreshRows() on
 * its IntersectionObserver: while `_isPaused` is true (the observer can lag a
 * frame behind a just-revealed pane, worse under load), refresh() early-returns
 * and only latches `_needsFullRefresh`. The reveal-repaint's terminal.refresh()
 * is then swallowed and the freshly-cleared render model never repaints.
 *
 * This spec drives the REAL production reveal path (manager.resetWebglTextureAtlases
 * -> resetWebglTextureAtlas -> forceRepaintThroughRenderPause) against a real
 * xterm Terminal + RenderService. It:
 *   1. proves the bug: while paused, a plain refresh() renders nothing;
 *   2. proves the fix: the real reveal repaint forces a full-viewport render
 *      through the paused gate and clears the pause latch;
 *   3. confirms recovery at the pixel level.
 *
 * The paused state is set deterministically rather than raced, because headless
 * Electron does not reliably reproduce the observer-lag timing (documented for
 * this bug class). The gate we force is the exact one the field bug hits.
 */

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
}

/**
 * Installs an in-page probe that instruments the active pane's REAL xterm
 * RenderService. Everything here runs against production objects; the only
 * test-only code is the recording wrapper around `_renderRows` and the manual
 * flip of `_isPaused` that stands in for the observer-lag race.
 */
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
        // Why: reveal clears the WebGL render model so a full rebuild is forced.
        // clearTextureAtlas() routes through RenderService and, crucially, also
        // requests a redraw — which is exactly what the paused gate then eats.
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
        // The real production reveal path — contains the fix under test.
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

test.describe('terminal reveal paused-render recovery', () => {
  test("reveal repaint forces a render through xterm's paused gate", async ({ orcaPage }) => {
    // Why: __store / __paneManagers live on the main Orca renderer window
    // (orcaPage), not Playwright's default first page.
    const page = orcaPage
    await waitForSessionReady(page)
    await waitForActiveTerminalManager(page)
    const tabId = (await getActiveTabId(page))!
    const ptyId = await waitForActivePanePtyId(page)

    await forceWebglOn(page, tabId)

    // Fill the viewport down to the bottom so a swallowed repaint is observable
    // both in the render ranges and on-screen.
    await execInTerminal(
      page,
      ptyId,
      `for i in $(seq 1 40); do echo "line $i ${BOTTOM_MARKER}_$i"; done`
    )
    await waitForTerminalOutput(page, `${BOTTOM_MARKER}_40`)
    // Clear-screen + reprint so the marker sits on the real bottom rows.
    await execInTerminal(
      page,
      ptyId,
      `clear; printf '%s\\n' "$(seq 1 30)"; echo "${BOTTOM_MARKER}_FINAL"`
    )
    await waitForTerminalOutput(page, `${BOTTOM_MARKER}_FINAL`)

    const revealed = await captureStableTabScreenshot(page, tabId)

    await installRevealRenderProbe(page, tabId)
    await probeCall(page, 'installProbe')

    // ---- Control: prove the bug. This sequence (clearTextureAtlas + refresh)
    // is byte-for-byte the PRE-FIX resetWebglTextureAtlas on origin/main, so it
    // faithfully replays the old reveal path. While paused, it renders nothing.
    await probeCall(page, 'setPaused', true)
    await probeCall(page, 'dirtyModelLikeReveal')
    await probeCall(page, 'plainRefresh')
    // Give any (non-existent) queued render a frame to land.
    await page.waitForTimeout(80)
    const afterPlainRefresh = await probeRead(page)

    expect(afterPlainRefresh.paused, 'terminal is in the paused-render state').toBe(true)
    expect(
      afterPlainRefresh.renderedRanges,
      'BUG REPRODUCED: while paused, plain refresh() is swallowed by the gate — no render fires'
    ).toHaveLength(0)

    // ---- Fix: the real reveal repaint must force a full render through the gate.
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

    // ---- Pixel-level confirmation: the surface still shows the correct content
    // after being driven through the paused gate (no stale/blank bottom rows).
    const afterFix = await captureStableTabScreenshot(page, tabId)
    const diff = compareTerminalScreenshots(revealed, afterFix)
    expect(
      diff.matches,
      `recovered surface matches the revealed content (diffRatio=${diff.diffRatio})`
    ).toBe(true)
  })
})
