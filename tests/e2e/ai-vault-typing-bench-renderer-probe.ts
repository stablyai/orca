import { expect, type Page } from '@stablyai/playwright-test'

export type RendererJank = {
  longTaskCount: number
  maxLongTaskMs: number
  totalLongTaskMs: number
  maxTimerDriftMs: number
  maxFrameGapMs: number
}

export async function startRendererJankProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const durations: number[] = []
    let maxTimerDriftMs = 0
    let maxFrameGapMs = 0
    let lastTimer = performance.now()
    let lastFrame = performance.now()
    let stopped = false
    const observer = new PerformanceObserver((list) => {
      durations.push(...list.getEntries().map((entry) => entry.duration))
    })
    observer.observe({ type: 'longtask' })
    const timer = window.setInterval(() => {
      const now = performance.now()
      maxTimerDriftMs = Math.max(maxTimerDriftMs, now - lastTimer - 16)
      lastTimer = now
    }, 16)
    const frame = (now: number): void => {
      maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame)
      lastFrame = now
      if (!stopped) {
        requestAnimationFrame(frame)
      }
    }
    requestAnimationFrame(frame)
    const target = window as Window & { __vaultBenchJank?: { stop: () => RendererJank } }
    target.__vaultBenchJank = {
      stop: () => {
        stopped = true
        window.clearInterval(timer)
        durations.push(...observer.takeRecords().map((entry) => entry.duration))
        observer.disconnect()
        return {
          longTaskCount: durations.length,
          maxLongTaskMs: Math.max(0, ...durations),
          totalLongTaskMs: durations.reduce((sum, value) => sum + value, 0),
          maxTimerDriftMs,
          maxFrameGapMs
        }
      }
    }
  })
}

export async function stopRendererJankProbe(page: Page): Promise<RendererJank> {
  return page.evaluate(() => {
    const target = window as Window & { __vaultBenchJank?: { stop: () => RendererJank } }
    if (!target.__vaultBenchJank) {
      throw new Error('Renderer jank probe was not installed')
    }
    const result = target.__vaultBenchJank.stop()
    delete target.__vaultBenchJank
    return result
  })
}

export async function triggerVaultRefresh(page: Page): Promise<void> {
  const refreshButton = page.getByRole('button', { name: 'Refresh Session History' })
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh Session History"]'
    )
    if (!button) {
      throw new Error('Vault refresh button unavailable')
    }
    const target = window as Window & {
      __vaultBenchRefresh?: { startedAt: number; durationMs: number | null }
    }
    const refresh = { startedAt: performance.now(), durationMs: null }
    target.__vaultBenchRefresh = refresh
    let sawBusy = false
    const observer = new MutationObserver(() => {
      sawBusy ||= button.getAttribute('aria-busy') === 'true'
      if (sawBusy && button.getAttribute('aria-busy') !== 'true') {
        refresh.durationMs = performance.now() - refresh.startedAt
        observer.disconnect()
      }
    })
    observer.observe(button, { attributes: true, attributeFilter: ['aria-busy'] })
    button.click()
  })
  await expect(refreshButton).toHaveAttribute('aria-busy', 'true', { timeout: 5_000 })
}

export async function readVaultRefreshDuration(page: Page): Promise<number> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const target = window as Window & {
            __vaultBenchRefresh?: { durationMs: number | null }
          }
          return target.__vaultBenchRefresh?.durationMs ?? null
        }),
      { timeout: 120_000 }
    )
    .not.toBeNull()
  return page.evaluate(() => {
    const target = window as Window & {
      __vaultBenchRefresh?: { durationMs: number | null }
    }
    const durationMs = target.__vaultBenchRefresh?.durationMs
    delete target.__vaultBenchRefresh
    if (durationMs === null || durationMs === undefined) {
      throw new Error('Vault refresh completion was not observed')
    }
    return durationMs
  })
}
