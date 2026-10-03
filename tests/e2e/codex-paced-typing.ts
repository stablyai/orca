import type { Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { focusActiveTerminalInput } from './helpers/terminal'
import {
  collectCodexEchoLatencyReport,
  installCodexEchoLatencyProbe,
  summarizeLatencies
} from './codex-composer-echo-latency-probe'

export async function measurePacedCodexTyping(
  page: Page,
  options: { keyCount: number; cadenceMs: number }
) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  const typed = Array.from(
    { length: options.keyCount },
    (_, index) => alphabet[index % alphabet.length]
  ).join('')
  await focusActiveTerminalInput(page)
  await installCodexEchoLatencyProbe(page, typed)
  const diagnostics = await page.evaluateHandle(() => {
    let lastTick = performance.now()
    let maxTimerDriftMs = 0
    const longTasks: { startAtMs: number; durationMs: number }[] = []
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({
          startAtMs: performance.timeOrigin + entry.startTime,
          durationMs: entry.duration
        })
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
    const timer = window.setInterval(() => {
      const now = performance.now()
      maxTimerDriftMs = Math.max(maxTimerDriftMs, now - lastTick - 16)
      lastTick = now
    }, 16)
    return {
      stop: () => {
        clearInterval(timer)
        observer.disconnect()
        return { maxTimerDriftMs, longTasks }
      }
    }
  })
  const schedule: { plannedAtMs: number; dispatchedAtMs: number }[] = []
  const startedAtMs = Date.now()
  try {
    for (const [index, char] of [...typed].entries()) {
      const plannedAtMs = startedAtMs + index * options.cadenceMs
      const remainingMs = plannedAtMs - Date.now()
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs))
      }
      schedule.push({ plannedAtMs, dispatchedAtMs: Date.now() })
      await page.keyboard.type(char)
    }
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              window.__codexEchoProbe
                ?.report()
                .samples.filter((sample) => sample.renderedAtMs !== null).length ?? 0
          ),
        {
          timeout: 30_000,
          message: 'Codex did not render every scheduled character'
        }
      )
      .toBe(options.keyCount)
    const echo = await collectCodexEchoLatencyReport(page)
    expect(echo.samples.map((sample) => sample.char).join('')).toBe(typed)
    const samples = echo.samples.map((sample) => ({ ...sample, ...schedule[sample.index] }))
    return {
      ...echo,
      typed,
      samples,
      diagnostics: await diagnostics.evaluate((probe) => probe.stop()),
      dispatchDelayMs: summarizeLatencies(
        schedule.map((sample) => sample.dispatchedAtMs - sample.plannedAtMs)
      ),
      plannedToKeyDownMs: summarizeLatencies(
        samples.map((sample) => sample.keyDownAtMs - sample.plannedAtMs)
      ),
      plannedToParseMs: summarizeLatencies(
        samples.map((sample) => sample.parsedAtMs - sample.plannedAtMs)
      ),
      plannedToRenderMs: summarizeLatencies(
        samples.flatMap((sample) =>
          sample.renderedAtMs === null ? [] : [sample.renderedAtMs - sample.plannedAtMs]
        )
      ),
      keyToParseMs: summarizeLatencies(samples.map((sample) => sample.keyToParseMs))
    }
  } finally {
    await diagnostics.evaluate((probe) => probe.stop()).catch(() => undefined)
    await diagnostics.dispose()
    await page.evaluate(() => window.__codexEchoProbe?.dispose()).catch(() => undefined)
  }
}
