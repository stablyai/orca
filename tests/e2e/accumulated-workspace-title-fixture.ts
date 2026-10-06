import type { Page } from '@stablyai/playwright-test'

type TitleFixtureWindow = Window & {
  __accumulatedFixtureTitleTrafficStop?: () => { updates: number }
}

/** Continuously updates titles on mounted panes to measure title-sync fanout. */
export async function startAccumulatedTitleTraffic(
  page: Page,
  intervalMs = 100
): Promise<{ registeredTabs: number; registeredPanes: number }> {
  return page.evaluate((interval) => {
    const target: TitleFixtureWindow = window
    // __paneManagers only contains mounted TerminalPane instances. Their
    // mount effect registers the same runtime owner used by production graph
    // publication, so this cannot manufacture ownership for cold tabs.
    const panes = [...(target.__paneManagers?.entries() ?? [])].flatMap(([tabId, manager]) =>
      manager.getPanes().map((pane) => ({ tabId, pane }))
    )
    if (panes.length === 0) {
      throw new Error('title workload requires at least one mounted runtime pane')
    }
    let updates = 0
    let sequence = 0
    const timer = window.setInterval(() => {
      const store = target.__store
      if (!store) {
        return
      }
      for (const { tabId, pane } of panes) {
        // Call the production store writer with the mount-local pane id. The
        // target came from a mounted manager, whose effect owns runtime
        // registration; cold synthetic tabs are never addressed.
        store
          .getState()
          .setRuntimePaneTitle(tabId, pane.id, `Synthetic title ${sequence++}-${Date.now()}`)
        updates += 1
      }
    }, interval)
    target.__accumulatedFixtureTitleTrafficStop = () => {
      window.clearInterval(timer)
      delete target.__accumulatedFixtureTitleTrafficStop
      return { updates }
    }
    return {
      registeredTabs: new Set(panes.map(({ tabId }) => tabId)).size,
      registeredPanes: panes.length
    }
  }, intervalMs)
}

export async function stopAccumulatedTitleTraffic(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target: TitleFixtureWindow = window
    target.__accumulatedFixtureTitleTrafficStop?.()
  })
}
