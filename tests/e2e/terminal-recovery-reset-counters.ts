import type { Page } from '@stablyai/playwright-test'

type RecoveryCounterWindow = Window & {
  __terminalTabOverlapResetCounts?: Record<string, number>
  __terminalTabOverlapResetTimes?: Record<string, number[]>
  __terminalTabOverlapSuppressVisibilityRecovery?: boolean
}

export async function instrumentTabResetCounters(page: Page, tabIds: string[]): Promise<void> {
  const instrumented = await page.evaluate((tabIds) => {
    const counterWindow = window as RecoveryCounterWindow
    counterWindow.__terminalTabOverlapResetCounts = Object.fromEntries(
      tabIds.map((tabId) => [tabId, 0])
    )
    counterWindow.__terminalTabOverlapResetTimes = Object.fromEntries(
      tabIds.map((tabId) => [tabId, []])
    )
    return tabIds.map((tabId) => {
      const manager = window.__paneManagers?.get(tabId)
      if (!manager?.resetWebglTextureAtlases) {
        return false
      }
      const originalReset = manager.resetWebglTextureAtlases.bind(manager)
      manager.resetWebglTextureAtlases = () => {
        const counts = counterWindow.__terminalTabOverlapResetCounts ?? {}
        counts[tabId] = (counts[tabId] ?? 0) + 1
        counterWindow.__terminalTabOverlapResetCounts = counts
        const times = counterWindow.__terminalTabOverlapResetTimes ?? {}
        times[tabId] = [...(times[tabId] ?? []), performance.now()]
        counterWindow.__terminalTabOverlapResetTimes = times
        originalReset()
      }
      return true
    })
  }, tabIds)
  if (!instrumented.every(Boolean)) {
    throw new Error(`could not instrument WebGL reset counters for tabs ${tabIds.join(', ')}`)
  }
}

export async function readTabResetCount(page: Page, tabId: string): Promise<number> {
  return page.evaluate(
    (tabId) => (window as RecoveryCounterWindow).__terminalTabOverlapResetCounts?.[tabId] ?? 0,
    tabId
  )
}

export async function readTabResetSnapshot(page: Page, tabId: string) {
  return page.evaluate((tabId) => {
    const counterWindow = window as RecoveryCounterWindow
    const times = counterWindow.__terminalTabOverlapResetTimes?.[tabId] ?? []
    return {
      count: counterWindow.__terminalTabOverlapResetCounts?.[tabId] ?? 0,
      latestAt: times.at(-1) ?? 0
    }
  }, tabId)
}

export async function setVisibilityRecoverySuppressed(
  page: Page,
  suppressed: boolean
): Promise<void> {
  await page.evaluate((suppressed) => {
    ;(window as RecoveryCounterWindow).__terminalTabOverlapSuppressVisibilityRecovery = suppressed
  }, suppressed)
}
