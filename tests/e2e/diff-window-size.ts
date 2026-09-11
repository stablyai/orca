import type { ElectronApplication } from '@playwright/test'

/**
 * Resizes the real Electron window. `page.setViewportSize` only resizes the page, which leaves a
 * side-by-side diff pane as narrow as the host display made it -- on CI that is narrower than a
 * dev machine, and a whole-line drag then lands on the sticky line-number column.
 */
export async function setDiffWindowSize(
  electronApp: ElectronApplication,
  width = 1600,
  height = 900
): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) {
        throw new Error('No Electron window')
      }
      window.setSize(size.width, size.height)
    },
    { width, height }
  )
}
