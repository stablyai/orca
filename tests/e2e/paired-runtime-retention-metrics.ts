import type { JSHandle, Page } from '@stablyai/playwright-test'

export type PairedRetentionSample = {
  bufferCells: number
  heapBytes: number
  mountedTargetManagers: number
  targetPanes: number
}

export async function readPairedRetentionSample(
  page: Page,
  tabIds: string[]
): Promise<PairedRetentionSample> {
  // Why no catch: without CDP there is no exact heap figure; the budget check must not skip.
  const session = await page.context().newCDPSession(page)
  // Why twice: right after parking, one pass leaves the disposed terminals' garbage (~20 MB)
  // for the next; the second frees it.
  await session.send('HeapProfiler.collectGarbage')
  await session.send('HeapProfiler.collectGarbage')
  // Why not performance.memory: it is a cached, rounded figure that can predate the GC above.
  const heapBytes = (await session.send('Runtime.getHeapUsage')).usedSize
  await session.detach()
  const sample = await page.evaluate((targets) => {
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
    return { bufferCells, mountedTargetManagers, targetPanes }
  }, tabIds)
  return { ...sample, heapBytes }
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
