import type { ElectronApplication } from '@stablyai/playwright-test'

export async function enableHiddenElectronCompositor(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    if (process.env.ORCA_E2E_HEADLESS === '1' && process.env.ORCA_E2E_HEADFUL !== '1') {
      for (const window of BrowserWindow.getAllWindows()) {
        const original = window.webContents.setBackgroundThrottling.bind(window.webContents)
        window.webContents.setBackgroundThrottling = (allowed) => {
          console.info('[hidden-throttle-change] ' + JSON.stringify({ allowed, stack: new Error().stack }))
          original(allowed)
        }
        window.webContents.setBackgroundThrottling(false)
      }
    }
  })
}
