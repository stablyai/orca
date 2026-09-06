import type { ElectronApplication } from '@stablyai/playwright-test'

export async function enableHiddenElectronCompositor(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    if (process.env.ORCA_E2E_HEADLESS === '1' && process.env.ORCA_E2E_HEADFUL !== '1') {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false)
      }
    }
  })
}
