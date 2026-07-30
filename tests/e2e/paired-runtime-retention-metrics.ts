import type { JSHandle, Page } from '@stablyai/playwright-test'

export type PairedRetentionSample = {
  bufferCells: number
  heapBytes: number | null
  mountedTargetManagers: number
  targetPanes: number
}

export async function readPairedRetentionSample(
  page: Page,
  tabIds: string[]
): Promise<PairedRetentionSample> {
  try {
    const session = await page.context().newCDPSession(page)
    await session.send('HeapProfiler.collectGarbage')
    await session.detach()
  } catch {
    // GC only improves measurement fidelity.
  }
  return page.evaluate((targets) => {
    let bufferCells = 0
    let mountedTargetManagers = 0
    let targetPanes = 0
    for (const tabId of targets) {
      const manager = window.__paneManagers?.get(tabId)
      if (!manager) {
        continue
      }
      mountedTargetManagers += 1
      for (const pane of manager.getPanes?.() ?? []) {
        const buffer = pane.terminal?.buffer?.active
        if (!buffer) {
          continue
        }
        targetPanes += 1
        bufferCells += buffer.length * pane.terminal.cols
      }
    }
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory
    return {
      bufferCells,
      heapBytes: memory?.usedJSHeapSize ?? null,
      mountedTargetManagers,
      targetPanes
    }
  }, tabIds)
}

export async function startRendererLagProbe(page: Page): Promise<JSHandle<{ stop: () => number }>> {
  return page.evaluateHandle(() => {
    const sampleMs = 16
    let lastAt = performance.now()
    let maxDriftMs = 0
    const timer = window.setInterval(() => {
      const now = performance.now()
      maxDriftMs = Math.max(maxDriftMs, now - lastAt - sampleMs)
      lastAt = now
    }, sampleMs)
    return {
      stop: () => {
        window.clearInterval(timer)
        return maxDriftMs
      }
    }
  })
}
