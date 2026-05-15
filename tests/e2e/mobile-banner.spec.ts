import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'

// Why: regression coverage for the mobile-presence-lock UX (PR #1532,
// docs/mobile-presence-lock.md). The original bug was that the prior banner
// mounted but was visually unobtrusive enough that users missed it. Strong DOM
// assertions guard the "doesn't mount / doesn't dismiss" regression class;
// screenshots attached via testInfo.attach surface in the Playwright artifacts
// upload so reviewers can eyeball the rendering on a failed run.
//
// Drives the renderer by sending the same IPC events main fires in production
// (runtime:terminalFitOverrideChanged, runtime:terminalDriverChanged — wired in
// useIpcEvents.ts). No production-code test backdoor; the spec exercises the
// renderer-side IPC listener → state mirror → banner JSX chain.

test.describe.configure({ mode: 'serial' })

test('mobile subscribe mounts overlay; Take back dismisses it', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)

  // Baseline: clean terminal, no overlay.
  const overlay = orcaPage.locator('.mobile-driver-banner')
  await expect(overlay).toHaveCount(0)
  await captureAttachment(orcaPage, testInfo, '01-desktop-clean.png')

  // Fire the IPC events main emits when a mobile client subscribes in 'auto'
  // mode (handleMobileSubscribe in src/main/runtime/orca-runtime.ts). The
  // renderer's listener calls setFitOverride + setDriverForPty, the banner
  // observes the change, and MobileDriverOverlay mounts.
  await electronApp.evaluate(
    ({ BrowserWindow }, args) => {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        win.webContents.send('runtime:terminalFitOverrideChanged', {
          ptyId: args.ptyId,
          mode: 'mobile-fit',
          cols: args.cols,
          rows: args.rows
        })
        win.webContents.send('runtime:terminalDriverChanged', {
          ptyId: args.ptyId,
          driver: { kind: 'mobile', clientId: 'fake-phone-1' }
        })
      }
    },
    { ptyId, cols: 45, rows: 20 }
  )

  await expect(overlay).toBeVisible({ timeout: 15_000 })
  await expect(overlay).toContainText(/mobile is driving this terminal/i)
  await expect(overlay).toContainText(/your keyboard is paused/i)

  const takeBack = overlay.getByRole('button', { name: /take back/i })
  await expect(takeBack).toBeVisible()

  await captureAttachment(orcaPage, testInfo, '02-mobile-driving.png')

  // Take back dismisses the overlay. The button calls runtime.restoreTerminalFit
  // via IPC; main responds with desktop-fit + idle driver events that we mirror
  // here so the renderer state lands on the take-back terminal state.
  await takeBack.click()
  await electronApp.evaluate(
    ({ BrowserWindow }, args) => {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        win.webContents.send('runtime:terminalFitOverrideChanged', {
          ptyId: args.ptyId,
          mode: 'desktop-fit',
          cols: 0,
          rows: 0
        })
        win.webContents.send('runtime:terminalDriverChanged', {
          ptyId: args.ptyId,
          driver: { kind: 'idle' }
        })
      }
    },
    { ptyId }
  )

  await expect(overlay).toBeHidden({ timeout: 15_000 })

  await captureAttachment(orcaPage, testInfo, '03-after-take-back.png')
})

// Why: writing the screenshot to testInfo.outputPath() lands the file in the
// per-test output dir that ships in the playwright-traces artifact uploaded by
// .github/workflows/e2e.yml on failure. The `body` form of testInfo.attach
// didn't reliably persist for the `list` reporter; the path round-trip does.
async function captureAttachment(page: Page, testInfo: TestInfo, fileName: string): Promise<void> {
  const dest = testInfo.outputPath(fileName)
  await page.screenshot({ path: dest, fullPage: true })
  await testInfo.attach(fileName, { path: dest, contentType: 'image/png' })
}
