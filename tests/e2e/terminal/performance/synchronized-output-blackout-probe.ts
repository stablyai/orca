// Measure onRender gaps and DEC 2026 latch-open durations; parser buffer updates can arrive before any visible render.
// An unclosed synchronized frame suppresses rows until ?2026l or xterm’s 1s forced flush.
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

// Keep the probe handle on window across evaluate calls, matching runtime-graph-publication-probe.
type BlackoutProbeWindow = Window & {
  __orcaSyncOutputBlackoutProbe?: { stop: () => SynchronizedOutputBlackoutSnapshot }
}

// Sample the target pane’s latch and report blocked-thread sampling gaps rather than hiding them.
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
      // Refuse a missing latch so zero blackouts cannot masquerade as a valid measurement.
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
