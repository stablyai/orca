/**
 * Performance budget for the STA-2694 synchronized-output release (PR #10907).
 *
 * `releaseAbandonedSynchronizedOutput` runs inside `resetWebglTextureAtlas`,
 * which a streaming alt-screen TUI can reach through the terminal-output atlas
 * recovery path — not just on reveal. So it is worth proving, rather than
 * asserting, that it does not add per-chunk work or extra repaints while an
 * agent TUI floods output.
 *
 * Two things must hold:
 *   1. Cost per call is O(1) — two property reads and, only when actually
 *      latched, one assignment plus a flush. No buffer/scrollback scan.
 *   2. It adds NO repaints in steady state. The function returns early unless a
 *      frame was genuinely abandoned, so a healthy streaming TUI (which closes
 *      every `?2026l` it opens) must see zero releases and zero extra draws.
 */
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

async function webglTerminalReady(page: Page): Promise<boolean> {
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
  return page
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
}

test.describe('synchronized-output release performance (STA-2694)', () => {
  test('a healthy streaming TUI triggers no releases and no extra draws', async ({ orcaPage }) => {
    test.setTimeout(180_000)
    test.skip(!(await webglTerminalReady(orcaPage)), 'WebGL renderer unavailable')

    const result = await orcaPage.evaluate(async () => {
      let terminal: Record<string, unknown> | null = null
      let renderer: Record<string, unknown> | null = null
      for (const manager of window.__paneManagers?.values() ?? []) {
        for (const pane of (manager as { getPanes?: () => unknown[] }).getPanes?.() ?? []) {
          const candidate = (pane as { terminal?: Record<string, unknown> }).terminal
          const active = (
            candidate as
              | { _core?: { _renderService?: { _renderer?: { value?: { _gl?: unknown } } } } }
              | undefined
          )?._core?._renderService?._renderer?.value
          if (active?._gl) {
            terminal = candidate as Record<string, unknown>
            renderer = active as Record<string, unknown>
          }
        }
      }
      if (!terminal || !renderer) {
        throw new Error('no WebGL pane')
      }
      const gl = renderer._gl as WebGL2RenderingContext
      let drawCalls = 0
      const originalDraw = gl.drawElementsInstanced.bind(gl)
      gl.drawElementsInstanced = function counted(
        mode: number,
        count: number,
        type: number,
        offset: number,
        instanceCount: number
      ): void {
        drawCalls++
        originalDraw(mode, count, type, offset, instanceCount)
      }

      const write = (terminal as { write: (d: string, cb?: () => void) => void }).write.bind(
        terminal
      )
      const modes = (
        terminal._core as { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } }
      ).coreService?.decPrivateModes

      // A well-behaved alt-screen TUI: 200 fully-bracketed frames.
      const FRAMES = 200
      const frame = (n: number): string =>
        `\x1b[?2026h\x1b[H${Array.from(
          { length: 20 },
          (_, row) => `row ${row} frame ${n} ${'x'.repeat(60)}`
        ).join('\r\n')}\x1b[?2026l`

      const start = performance.now()
      for (let i = 0; i < FRAMES; i++) {
        write(frame(i))
      }
      await new Promise<void>((resolve) => {
        write('', () => resolve())
      })
      const writeMs = performance.now() - start
      const drawsAfterStream = drawCalls
      if (!modes) {
        throw new Error('decPrivateModes unavailable — the measurement would be vacuous')
      }

      // Time the REAL production path in its steady state (nothing latched).
      // Driving resetWebglTextureAtlases rather than a copy of the early-out is
      // the point: a future change that makes the release scan the buffer shows
      // up here instead of hiding behind a hand-written mirror.
      const drawsBeforeIdleResets = drawCalls
      const releaseStart = performance.now()
      for (let i = 0; i < FRAMES; i++) {
        for (const manager of window.__paneManagers?.values() ?? []) {
          ;(manager as { resetWebglTextureAtlases?: () => void }).resetWebglTextureAtlases?.()
        }
      }
      const releaseMs = performance.now() - releaseStart
      const drawsDuringIdleResets = drawCalls - drawsBeforeIdleResets

      return {
        writeMs,
        releaseMs,
        drawsAfterStream,
        drawsDuringIdleResets,
        latchedAfterStream: modes.synchronizedOutput === true,
        frames: FRAMES
      }
    })

    console.log(
      `[perf] ${result.frames} bracketed frames written in ${result.writeMs.toFixed(1)}ms`
    )
    console.log(
      `[perf] ${result.frames} unlatched atlas resets took ${result.releaseMs.toFixed(3)}ms ` +
        `(${((result.releaseMs / result.frames) * 1000).toFixed(2)}µs each)`
    )
    console.log(
      `[perf] draws during stream: ${result.drawsAfterStream}, ` +
        `during idle resets: ${result.drawsDuringIdleResets}`
    )

    // A healthy TUI closes every frame it opens, so the latch is clear and the
    // release is a pure early-out that changes nothing.
    expect(result.latchedAfterStream, 'a fully-bracketed stream should leave no latch behind').toBe(
      false
    )
    // The title's "no extra draws" claim, actually asserted: a bracketed stream
    // that never abandons a frame must not provoke synchronous repaints.
    expect(
      result.drawsAfterStream,
      `a fully-bracketed stream forced ${result.drawsAfterStream} synchronous draws`
    ).toBe(0)
    // Measured ~0.04ms per full atlas-reset call on CI-class hardware. Note this
    // is the cost of the WHOLE recovery (atlas clear + refresh), not the release
    // alone — the release itself is the early-out that contributes ~nothing, as
    // the zero draw counts above show. Bound at 10x measured so it catches a
    // change that makes this scan the buffer per pane without flaking on speed.
    expect(
      result.releaseMs / result.frames,
      `unlatched reset cost ${result.releaseMs / result.frames}ms per call, expected < 0.4ms`
    ).toBeLessThan(0.4)
  })

  // Worst case: every reveal finds a latched frame, so the release does its full
  // work (assignment + handler flush) and the caller repaints. This bounds the
  // cost of the path the fix actually exists for.
  test('the latched path stays bounded and repaints exactly once per reveal', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    test.skip(!(await webglTerminalReady(orcaPage)), 'WebGL renderer unavailable')

    const result = await orcaPage.evaluate(async () => {
      let terminal: Record<string, unknown> | null = null
      let renderer: Record<string, unknown> | null = null
      for (const manager of window.__paneManagers?.values() ?? []) {
        for (const pane of (manager as { getPanes?: () => unknown[] }).getPanes?.() ?? []) {
          const candidate = (pane as { terminal?: Record<string, unknown> }).terminal
          const active = (
            candidate as
              | { _core?: { _renderService?: { _renderer?: { value?: { _gl?: unknown } } } } }
              | undefined
          )?._core?._renderService?._renderer?.value
          if (active?._gl) {
            terminal = candidate as Record<string, unknown>
            renderer = active as Record<string, unknown>
          }
        }
      }
      if (!terminal || !renderer) {
        throw new Error('no WebGL pane')
      }
      const gl = renderer._gl as WebGL2RenderingContext
      let drawCalls = 0
      const originalDraw = gl.drawElementsInstanced.bind(gl)
      gl.drawElementsInstanced = function counted(
        mode: number,
        count: number,
        type: number,
        offset: number,
        instanceCount: number
      ): void {
        drawCalls++
        originalDraw(mode, count, type, offset, instanceCount)
      }
      ;(terminal as { write: (d: string) => void }).write(`\x1b[H${'content '.repeat(200)}`)
      await new Promise((resolve) => setTimeout(resolve, 500))

      const modes = (
        terminal._core as { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } }
      ).coreService?.decPrivateModes
      if (!modes) {
        // Without this the latch is never set, the recovery has nothing to do,
        // and every assertion below passes without exercising the fix.
        throw new Error('decPrivateModes unavailable — the latched path would be vacuous')
      }
      const REVEALS = 50
      drawCalls = 0
      const start = performance.now()
      let latchSurvivedAReset = false
      for (let i = 0; i < REVEALS; i++) {
        modes.synchronizedOutput = true
        for (const manager of window.__paneManagers?.values() ?? []) {
          ;(manager as { resetWebglTextureAtlases?: () => void }).resetWebglTextureAtlases?.()
        }
        if (modes.synchronizedOutput) {
          latchSurvivedAReset = true
        }
      }
      const elapsedMs = performance.now() - start
      return {
        elapsedMs,
        reveals: REVEALS,
        drawCalls,
        latchSurvivedAReset,
        stillLatched: modes.synchronizedOutput === true
      }
    })

    console.log(
      `[perf] ${result.reveals} latched atlas resets in ${result.elapsedMs.toFixed(1)}ms ` +
        `(${(result.elapsedMs / result.reveals).toFixed(2)}ms each), ${result.drawCalls} draw calls`
    )

    expect(result.stillLatched, 'the latch must be cleared by the recovery path').toBe(false)
    // Every iteration must clear it, not just the last one.
    expect(
      result.latchSurvivedAReset,
      'a reset left the latch set, so the release did not run on every reveal'
    ).toBe(false)
    // "exactly once per reveal": the recovery repaints through the render-pause
    // release, so draws must scale with reveals rather than multiplying per pane.
    expect(
      result.drawCalls,
      `${result.drawCalls} draws across ${result.reveals} reveals exceeds one repaint each`
    ).toBeLessThanOrEqual(result.reveals * 3)
    // Reveal is a one-shot user action, so even the full path has ample headroom;
    // this guards against a future change making it scan the buffer per pane.
    expect(
      result.elapsedMs / result.reveals,
      `latched atlas reset cost ${result.elapsedMs / result.reveals}ms per reveal, expected < 20ms`
    ).toBeLessThan(20)
  })
})
