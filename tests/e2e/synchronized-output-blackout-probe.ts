/**
 * Measures DEC 2026 render blackouts in the focused pane's xterm.
 *
 * Why buffer polling cannot see this bug: xterm's parser writes into the buffer
 * whether or not synchronized output is open, so the existing bench's
 * xterm-buffer observation reports a keystroke as "echoed" while the screen is
 * still showing the previous frame. What the user sees is the RENDER.
 *
 * xterm (6.1.0-beta.303) suppresses all row rendering while
 * `decPrivateModes.synchronizedOutput` is set — `RenderService.refreshRows`
 * returns early into `SyncOutputHandler.bufferRows` — and the only escapes are
 * the closing `\x1b[?2026l` or a 1000 ms timeout armed once per buffering
 * episode. So a frame whose close is delayed freezes the pane for up to a
 * second and then repaints everything at once, which is exactly the reported
 * symptom.
 *
 * This probe records actual `onRender` timestamps and how long the
 * synchronized-output latch stays open, so a run can distinguish "echo arrived
 * late" from "echo arrived on time but was not painted".
 */
import type { Page } from '@stablyai/playwright-test'

export type SynchronizedOutputBlackoutSnapshot = {
  installed: boolean
  reason: string
  /** Wall time the probe observed, ms. */
  observedMs: number
  renderCount: number
  /** Gaps between consecutive renders, ms. */
  maxRenderGapMs: number
  p90RenderGapMs: number
  /** Episodes where the latch was observed open, ms each. */
  latchOpenEpisodes: number[]
  maxLatchOpenMs: number
  /** Episodes at/over this are xterm's 1s forced flush rather than a real close. */
  timeoutScaleEpisodes: number
  samples: number
}

type BlackoutProbeTerminal = {
  onRender?: (listener: () => void) => { dispose: () => void }
  /** Public IModes getter; xterm's internals are minified in the bundle. */
  modes?: { synchronizedOutputMode?: boolean }
}

type BlackoutProbePane = { terminal?: BlackoutProbeTerminal }

// Matches the sibling probes (runtime-graph-publication-probe): the handle must
// live on `window` to survive between page.evaluate calls, and `declare global`
// would need an `interface` the lint rules forbid.
type BlackoutProbeWindow = Window & {
  __orcaSyncOutputBlackoutProbe?: { stop: () => SynchronizedOutputBlackoutSnapshot }
}

/**
 * Installs the probe on the focused pane of `tabId`. Sampling runs on a short
 * interval; a renderer thread blocked for N ms shows up as a sampling gap,
 * which is reported rather than hidden.
 */
export async function startSynchronizedOutputBlackoutProbe(
  page: Page,
  tabId: string
): Promise<{ installed: boolean; reason: string }> {
  return page.evaluate((activeTabId) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe owns this property on its own renderer window; nothing else reads or writes it.
    const target = window as BlackoutProbeWindow
    target.__orcaSyncOutputBlackoutProbe?.stop()
    const manager = window.__paneManagers?.get(activeTabId)
    const pane: BlackoutProbePane | null =
      manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const terminal = pane?.terminal
    if (!terminal) {
      return { installed: false, reason: 'no focused pane terminal' }
    }
    if (typeof terminal.modes?.synchronizedOutputMode !== 'boolean') {
      // Why fail loudly: a silently absent latch would report zero blackouts
      // and read as "not reproduced".
      return { installed: false, reason: 'terminal.modes.synchronizedOutputMode not reachable' }
    }
    if (typeof terminal.onRender !== 'function') {
      return { installed: false, reason: 'terminal.onRender unavailable' }
    }

    const startedAt = performance.now()
    const renderAtMs: number[] = []
    const latchOpenEpisodes: number[] = []
    let samples = 0
    let latchOpenedAt: number | null = null
    const subscription = terminal.onRender(() => {
      renderAtMs.push(performance.now())
    })
    const sampleLatch = (): void => {
      samples += 1
      const open = terminal.modes?.synchronizedOutputMode === true
      if (open && latchOpenedAt === null) {
        latchOpenedAt = performance.now()
      } else if (!open && latchOpenedAt !== null) {
        latchOpenEpisodes.push(performance.now() - latchOpenedAt)
        latchOpenedAt = null
      }
    }
    const timer = window.setInterval(sampleLatch, 4)

    target.__orcaSyncOutputBlackoutProbe = {
      stop: () => {
        window.clearInterval(timer)
        subscription.dispose()
        sampleLatch()
        if (latchOpenedAt !== null) {
          latchOpenEpisodes.push(performance.now() - latchOpenedAt)
        }
        const gaps: number[] = []
        for (let index = 1; index < renderAtMs.length; index++) {
          gaps.push(renderAtMs[index] - renderAtMs[index - 1])
        }
        const sortedGaps = [...gaps].sort((a, b) => a - b)
        const round = (value: number): number => Number(value.toFixed(1))
        return {
          installed: true,
          reason: 'ok',
          observedMs: round(performance.now() - startedAt),
          renderCount: renderAtMs.length,
          maxRenderGapMs: round(sortedGaps.at(-1) ?? 0),
          p90RenderGapMs: round(
            sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(0.9 * sortedGaps.length))] ?? 0
          ),
          latchOpenEpisodes: latchOpenEpisodes
            .map(round)
            .sort((a, b) => b - a)
            .slice(0, 20),
          maxLatchOpenMs: round(Math.max(0, ...latchOpenEpisodes)),
          // 900ms+ cannot be a real close at Codex's 120 FPS draw rate; it is
          // xterm's 1000ms forced flush.
          timeoutScaleEpisodes: latchOpenEpisodes.filter((episode) => episode >= 900).length,
          samples
        }
      }
    }
    return { installed: true, reason: 'ok' }
  }, tabId)
}

export async function stopSynchronizedOutputBlackoutProbe(
  page: Page
): Promise<SynchronizedOutputBlackoutSnapshot | null> {
  return page.evaluate(
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same probe-owned property as startSynchronizedOutputBlackoutProbe installs.
      (window as BlackoutProbeWindow).__orcaSyncOutputBlackoutProbe?.stop() ?? null
  )
}
