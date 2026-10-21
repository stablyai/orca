import type { Page } from '@stablyai/playwright-test'

const PROBE_KEY = 'orcaE2eHostHistoryProbe'

/**
 * Gives Orca's own document a back entry, so a side-button press that slips past the renderer's
 * cancel would visibly pop it. Without one, "the document did not navigate" cannot fail.
 */
export async function pushHostHistoryProbe(page: Page): Promise<void> {
  await page.evaluate((key) => {
    // Why same URL: only history.state changes, so app routing never sees the probe.
    window.history.pushState({ [key]: true }, '')
  }, PROBE_KEY)
}

/** True while the probe entry is still current, i.e. nothing navigated Orca's document back. */
export async function hostHistoryProbeIsCurrent(page: Page): Promise<boolean> {
  return page.evaluate((key) => {
    const state: unknown = window.history.state
    return typeof state === 'object' && state !== null && key in state
  }, PROBE_KEY)
}
