import type { ElectronApplication, Page } from '@stablyai/playwright-test'

/** Inject diagnostic eligibility without showing or activating the test window. */
export async function makeResourceManagerFixtureVisible(
  app: ElectronApplication,
  page: Page
): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      // Spoof diagnostic eligibility while keeping the native window hidden.
      window.isVisible = () => true
      window.isMinimized = () => false
      window.webContents.send('memory:resourceWindowVisibility', true)
    }
  })
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}
