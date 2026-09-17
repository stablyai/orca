/**
 * Diagnostic-only probe for renderer runtime-graph publication cost.
 *
 * `window.api` is frozen by contextBridge, so the renderer cannot wrap
 * `runtime.syncWindowGraph`. Instead this counts publications where they land —
 * main's `runtime:syncWindowGraph` invoke handler.
 *
 * `publications` and `mainHandler` are trustworthy. The long-task fields are NOT
 * yet: on 2026-09-16 an injected 250 ms renderer busy-wait produced zero entries
 * even though `longtask` is in `supportedEntryTypes`, so a zero there means
 * "oracle unproven", not "no long task happened". Run with
 * ORCA_TYPING_BENCH_GRAPH_PROBE_SELFTEST_MS and require a non-zero
 * `selfTestLongTaskMs` before believing any long-task number.
 *
 * Renderer-side per-publication build time is unavailable here; attribute it
 * with a separate --cpu-profile run instead.
 *
 * Keep this out of acceptance timing runs (gate: ORCA_TYPING_BENCH_GRAPH_PROBE=1).
 */
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

const GRAPH_CHANNEL = 'runtime:syncWindowGraph'

export type DurationSummary = {
  count: number
  totalMs: number
  maxMs: number
  p50Ms: number
  p90Ms: number
}

export type RuntimeGraphPublicationProbeSnapshot = {
  mainCounterInstalled: boolean
  mainCounterReason: string
  rendererObserverInstalled: boolean
  rendererObserverReason: string
  /** Publications counted at main's invoke handler. */
  publications: number
  /** Main-side handler duration (excludes the renderer-side graph build). */
  mainHandler: DurationSummary
  /** Gaps between consecutive publications, epoch ms. */
  publicationIntervalMs: DurationSummary
  longTasks: DurationSummary
  /** Non-zero only when the self-test ran; proves the long-task oracle is live. */
  selfTestLongTaskMs: number
  /** Long tasks whose window contains a publication's main-side arrival. */
  longTasksAroundPublication: DurationSummary
  longestLongTasks: { startEpochMs: number; durationMs: number }[]
}

type MainProbeGlobals = {
  __orcaGraphPublicationMainProbe?: {
    stop: () => { count: number; handlerMs: number[]; atEpochMs: number[] }
  }
}

type RendererProbeWindow = Window & {
  __orcaGraphPublicationRendererProbe?: {
    stop: () => { timeOrigin: number; longTasks: { start: number; duration: number }[] }
  }
}

function summarize(values: number[]): DurationSummary {
  if (values.length === 0) {
    return { count: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p90Ms: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0
  const round = (value: number): number => Number(value.toFixed(1))
  return {
    count: sorted.length,
    totalMs: round(sorted.reduce((sum, value) => sum + value, 0)),
    maxMs: round(sorted.at(-1) ?? 0),
    p50Ms: round(at(0.5)),
    p90Ms: round(at(0.9))
  }
}

/**
 * Presence precondition for the long-task oracle: burns a known span on the
 * renderer thread so a run that reports zero long tasks has proved it could
 * have seen one. Returns the observed duration, or 0 if the observer missed it.
 */
export async function injectRendererLongTaskSelfTest(page: Page, busyMs: number): Promise<number> {
  return page.evaluate((durationMs) => {
    const deadline = performance.now() + durationMs
    while (performance.now() < deadline) {
      // Intentional busy wait: setTimeout would not produce a long task.
    }
    return durationMs
  }, busyMs)
}

export async function startRuntimeGraphPublicationProbe(
  electronApp: ElectronApplication,
  page: Page
): Promise<{ main: string; renderer: string }> {
  const main = await electronApp.evaluate(({ ipcMain }, channel): string => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: diagnostic-only read of Electron's private invoke-handler map; every use is guarded by the shape checks below.
    const registry = (ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> })
      ._invokeHandlers
    if (!(registry instanceof Map)) {
      return 'no-invoke-handler-registry'
    }
    const original = registry.get(channel)
    if (typeof original !== 'function') {
      return `handler-missing typeof=${typeof original}`
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron stores invoke handlers as callables; arguments are forwarded unchanged and never introspected.
    const call = original as (...args: unknown[]) => unknown
    const handlerMs: number[] = []
    const atEpochMs: number[] = []
    const publications = { count: 0, handlerMs, atEpochMs }
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      const startedAt = Date.now()
      const startedHr = process.hrtime.bigint()
      publications.count += 1
      publications.atEpochMs.push(startedAt)
      try {
        return await call(...args)
      } finally {
        publications.handlerMs.push(Number(process.hrtime.bigint() - startedHr) / 1e6)
      }
    }
    registry.set(channel, wrapped)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main-process bag read back only by the paired stop() call in this same run.
    const globals = globalThis as unknown as MainProbeGlobals
    globals.__orcaGraphPublicationMainProbe = {
      stop: () => {
        if (registry.get(channel) === wrapped) {
          registry.set(channel, original)
        }
        delete globals.__orcaGraphPublicationMainProbe
        return publications
      }
    }
    return 'installed'
  }, GRAPH_CHANNEL)

  const renderer = await page.evaluate((): string => {
    const probeWindow: RendererProbeWindow = window
    if (probeWindow.__orcaGraphPublicationRendererProbe) {
      return 'already-installed'
    }
    const supported = PerformanceObserver.supportedEntryTypes ?? []
    if (!supported.includes('longtask')) {
      return `longtask-unsupported supported=${supported.join('|')}`
    }
    const longTasks: { start: number; duration: number }[] = []
    let observer: PerformanceObserver
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ start: entry.startTime, duration: entry.duration })
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch (error) {
      return `longtask-observer-unavailable ${String(error)}`
    }
    probeWindow.__orcaGraphPublicationRendererProbe = {
      stop: () => {
        observer.disconnect()
        delete probeWindow.__orcaGraphPublicationRendererProbe
        return { timeOrigin: performance.timeOrigin, longTasks }
      }
    }
    return 'installed'
  })

  return { main, renderer }
}

export async function stopRuntimeGraphPublicationProbe(
  electronApp: ElectronApplication,
  page: Page,
  start: { main: string; renderer: string },
  selfTestBeforeEpochMs = 0
): Promise<RuntimeGraphPublicationProbeSnapshot> {
  const mainResult =
    start.main === 'installed'
      ? await electronApp.evaluate(() => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads back the bag installed by startRuntimeGraphPublicationProbe in this run.
          const globals = globalThis as unknown as MainProbeGlobals
          return globals.__orcaGraphPublicationMainProbe?.stop() ?? null
        })
      : null
  const rendererResult =
    start.renderer === 'installed'
      ? await page.evaluate(() => {
          const probeWindow: RendererProbeWindow = window
          return probeWindow.__orcaGraphPublicationRendererProbe?.stop() ?? null
        })
      : null

  const publicationEpochMs = mainResult?.atEpochMs ?? []
  const intervals = publicationEpochMs
    .slice(1)
    .map((value, index) => value - (publicationEpochMs[index] ?? value))
  const timeOrigin = rendererResult?.timeOrigin ?? 0
  const longTasks = (rendererResult?.longTasks ?? []).map((task) => ({
    startEpochMs: timeOrigin + task.start,
    durationMs: task.duration
  }))
  // A renderer graph build ends at the invoke; allow slack for IPC transit either way.
  const around = longTasks.filter((task) =>
    publicationEpochMs.some(
      (at) => at >= task.startEpochMs - 5 && at <= task.startEpochMs + task.durationMs + 50
    )
  )

  return {
    mainCounterInstalled: start.main === 'installed',
    mainCounterReason: start.main,
    rendererObserverInstalled: start.renderer === 'installed',
    rendererObserverReason: start.renderer,
    publications: mainResult?.count ?? 0,
    mainHandler: summarize(mainResult?.handlerMs ?? []),
    publicationIntervalMs: summarize(intervals),
    longTasks: summarize(longTasks.map((task) => task.durationMs)),
    selfTestLongTaskMs: Number(
      (
        longTasks.find((task) => task.startEpochMs <= selfTestBeforeEpochMs)?.durationMs ?? 0
      ).toFixed(1)
    ),
    longTasksAroundPublication: summarize(around.map((task) => task.durationMs)),
    longestLongTasks: [...longTasks]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10)
      .map((task) => ({
        startEpochMs: task.startEpochMs,
        durationMs: Number(task.durationMs.toFixed(1))
      }))
  }
}
