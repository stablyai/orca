import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import type { BrowserWindow } from 'electron'

export async function presentNativeIbusWindow(
  electronApp: ElectronApplication,
  page: Page
): Promise<void> {
  const ownedWindow = await electronApp.browserWindow(page)
  try {
    await ownedWindow.evaluate((window: BrowserWindow) => {
      if (
        process.platform !== 'linux' ||
        process.env.GITHUB_ACTIONS !== 'true' ||
        process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
        process.env.ORCA_E2E_NATIVE_IBUS_HANGUL !== '1' ||
        process.env.ORCA_E2E_NATIVE_IBUS_XVFB !== '1' ||
        !/^:\d+(?:\.\d+)?$/.test(process.env.DISPLAY ?? '') ||
        process.env.ORCA_BACKGROUND_LAUNCH !== '1' ||
        !window ||
        window.isDestroyed() ||
        window.isVisible()
      ) {
        throw new Error('Native IBus presentation requires an owned hosted-CI Xvfb window')
      }
      // Aura needs logical visibility to accept native keyboard input.
      window.showInactive()
    })
    await expect
      .poll(() => ownedWindow.evaluate((window: BrowserWindow) => window.isVisible()))
      .toBe(true)
    await page.waitForFunction(() => document.visibilityState === 'visible')
  } finally {
    await ownedWindow.dispose()
  }
}
