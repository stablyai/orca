import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'

// Why: regression coverage for the mobile-presence-lock UX (PR #1532,
// docs/mobile-presence-lock.md). The original bug was that the prior banner
// mounted but was visually unobtrusive enough that users missed it. Strong DOM
// assertions guard the "doesn't mount / doesn't dismiss" regression class;
// screenshots ride in the playwright-traces artifact upload so reviewers can
// eyeball the rendering on a failed run.
//
// Drives the renderer by sending the same IPC events main fires in production
// (runtime:terminalFitOverrideChanged, runtime:terminalDriverChanged — wired in
// useIpcEvents.ts). No production-code test backdoor; the spec exercises the
// renderer-side IPC listener → state mirror → banner JSX chain.

test.describe.configure({ mode: 'serial' })

test('mobile subscribe mounts overlay; collapse → chip; Take back dismisses', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await installRestoreTerminalFitRecorder(electronApp)

  const overlay = orcaPage.locator('.mobile-driver-banner')
  await expect(overlay).toHaveCount(0)

  // Fire the IPC events main emits when a mobile client subscribes in 'auto'
  // mode (handleMobileSubscribe in src/main/runtime/orca-runtime.ts). The
  // renderer's listener calls setFitOverride + setDriverForPty, the banner
  // observes the change, and MobileDriverOverlay mounts in loud mode.
  await sendMobileSubscribeIpc(electronApp, { ptyId, cols: 45, rows: 20 })

  await expect(overlay).toBeVisible({ timeout: 15_000 })
  await expect(overlay).toContainText(/mobile is driving this terminal/i)
  await expect(overlay).toContainText(/your keyboard is paused/i)
  await expectExpandedOverlayCoversPane(orcaPage, ptyId)

  const takeBack = overlay.getByRole('button', { name: /take back/i })
  const collapse = overlay.getByRole('button', { name: /^collapse$/i })
  await expect(takeBack).toBeVisible()
  await expect(collapse).toBeVisible()

  await captureAttachment(orcaPage, testInfo, 'overlay-loud.png')

  // Click Collapse → loud overlay swaps to the corner chip while the lock stays
  // engaged. The user can keep watching live mobile output while the chip
  // remains a one-click escape hatch back to desktop control.
  await collapse.click()
  await expect(overlay).toContainText(/mobile driving/i)
  await expect(overlay.getByRole('button', { name: /take back/i })).toBeVisible()
  await expect(overlay).not.toContainText(/your keyboard is paused/i)
  await expectChipIsCompactInPane(orcaPage, ptyId)

  await captureAttachment(orcaPage, testInfo, 'overlay-collapsed.png')

  await overlay.getByRole('button', { name: /mobile driving/i }).click()
  await expect(overlay).toContainText(/your keyboard is paused/i)
  await expectExpandedOverlayCoversPane(orcaPage, ptyId)

  await collapse.click()
  await expect(overlay).not.toContainText(/your keyboard is paused/i)

  // Take back from the chip dismisses the overlay. The button calls
  // runtime.restoreTerminalFit via IPC; main responds with desktop-fit + idle
  // driver events that we mirror here so the renderer state lands on the
  // post-take-back terminal state.
  await overlay.getByRole('button', { name: /take back/i }).click()
  await expectRestoreTerminalFitCalls(electronApp, [ptyId])
  await sendDesktopRestoreIpc(electronApp, { ptyId })
  await expect(overlay).toBeHidden({ timeout: 15_000 })
})

test('held phone-fit state mounts restore overlay without collapse', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await installRestoreTerminalFitRecorder(electronApp)

  const overlay = orcaPage.locator('.mobile-driver-banner')
  await expect(overlay).toHaveCount(0)

  // Held-fit is the post-mobile-disconnect state: the phone-fit override remains
  // while the driver returns to idle. It should stay loud because there is no
  // active mobile output to keep watching behind a collapsed chip.
  await sendHeldPhoneFitIpc(electronApp, { ptyId, cols: 45, rows: 20 })

  await expect(overlay).toBeVisible({ timeout: 15_000 })
  await expect(overlay).toContainText(/held at phone size/i)
  await expect(overlay).toContainText(/restore to use it on your desktop/i)
  await expect(overlay.getByRole('button', { name: /restore desktop size/i })).toBeVisible()
  await expect(overlay.getByRole('button', { name: /^collapse$/i })).toHaveCount(0)
  await expect(overlay.getByRole('button', { name: /take back/i })).toHaveCount(0)
  await expectExpandedOverlayCoversPane(orcaPage, ptyId)

  await captureAttachment(orcaPage, testInfo, 'overlay-held-fit.png')

  await overlay.getByRole('button', { name: /restore desktop size/i }).click()
  await expectRestoreTerminalFitCalls(electronApp, [ptyId])
  await sendDesktopRestoreIpc(electronApp, { ptyId })
  await expect(overlay).toBeHidden({ timeout: 15_000 })
})

async function sendMobileSubscribeIpc(
  electronApp: ElectronApplication,
  args: { ptyId: string; cols: number; rows: number }
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      win.webContents.send('runtime:terminalFitOverrideChanged', {
        ptyId: payload.ptyId,
        mode: 'mobile-fit',
        cols: payload.cols,
        rows: payload.rows
      })
      win.webContents.send('runtime:terminalDriverChanged', {
        ptyId: payload.ptyId,
        driver: { kind: 'mobile', clientId: 'fake-phone-1' }
      })
    }
  }, args)
}

async function sendHeldPhoneFitIpc(
  electronApp: ElectronApplication,
  args: { ptyId: string; cols: number; rows: number }
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      win.webContents.send('runtime:terminalFitOverrideChanged', {
        ptyId: payload.ptyId,
        mode: 'mobile-fit',
        cols: payload.cols,
        rows: payload.rows
      })
      win.webContents.send('runtime:terminalDriverChanged', {
        ptyId: payload.ptyId,
        driver: { kind: 'idle' }
      })
    }
  }, args)
}

async function sendDesktopRestoreIpc(
  electronApp: ElectronApplication,
  args: { ptyId: string }
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      win.webContents.send('runtime:terminalFitOverrideChanged', {
        ptyId: payload.ptyId,
        mode: 'desktop-fit',
        cols: 0,
        rows: 0
      })
      win.webContents.send('runtime:terminalDriverChanged', {
        ptyId: payload.ptyId,
        driver: { kind: 'idle' }
      })
    }
  }, args)
}

async function installRestoreTerminalFitRecorder(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    const testGlobal = globalThis as typeof globalThis & {
      __mobileBannerRestoreCalls?: string[]
    }
    testGlobal.__mobileBannerRestoreCalls = []
    // Why: the renderer state is driven by production IPC events in this spec,
    // so the runtime has no real mobile subscriber to reclaim. Replace only the
    // main-process handler inside the test process to prove the button invokes
    // the production channel and payload before we mirror the resulting events.
    ipcMain.removeHandler('runtime:restoreTerminalFit')
    ipcMain.handle('runtime:restoreTerminalFit', (_event, args: { ptyId: string }) => {
      testGlobal.__mobileBannerRestoreCalls?.push(args.ptyId)
      return { restored: true }
    })
  })
}

async function expectRestoreTerminalFitCalls(
  electronApp: ElectronApplication,
  expected: string[]
): Promise<void> {
  await expect
    .poll(
      () =>
        electronApp.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __mobileBannerRestoreCalls?: string[]
              }
            ).__mobileBannerRestoreCalls ?? []
        ),
      { message: 'restoreTerminalFit should be invoked through the production IPC channel' }
    )
    .toEqual(expected)
}

async function expectExpandedOverlayCoversPane(page: Page, ptyId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((targetPtyId) => {
          const pane = Array.from(document.querySelectorAll<HTMLElement>('[data-pty-id]')).find(
            (node) => node.dataset.ptyId === targetPtyId
          )
          const overlay = document.querySelector<HTMLElement>('.mobile-driver-banner')
          if (!pane || !overlay) {
            return false
          }
          const paneBox = pane.getBoundingClientRect()
          const overlayBox = overlay.getBoundingClientRect()
          return (
            Math.abs(overlayBox.left - paneBox.left) <= 2 &&
            Math.abs(overlayBox.top - paneBox.top) <= 2 &&
            overlayBox.width >= paneBox.width - 2 &&
            overlayBox.height >= paneBox.height - 2
          )
        }, ptyId),
      { message: 'expanded overlay should cover the terminal pane' }
    )
    .toBe(true)
}

async function expectChipIsCompactInPane(page: Page, ptyId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((targetPtyId) => {
          const pane = Array.from(document.querySelectorAll<HTMLElement>('[data-pty-id]')).find(
            (node) => node.dataset.ptyId === targetPtyId
          )
          const chip = document.querySelector<HTMLElement>('.mobile-driver-banner')
          if (!pane || !chip) {
            return false
          }
          const paneBox = pane.getBoundingClientRect()
          const chipBox = chip.getBoundingClientRect()
          const rightInset = paneBox.right - chipBox.right
          const topInset = chipBox.top - paneBox.top
          return (
            chipBox.width < paneBox.width * 0.6 &&
            chipBox.height <= 40 &&
            rightInset >= 6 &&
            rightInset <= 16 &&
            topInset >= 6 &&
            topInset <= 16
          )
        }, ptyId),
      { message: 'collapsed chip should stay compact in the terminal pane corner' }
    )
    .toBe(true)
}

// Why: writing the screenshot to testInfo.outputPath() lands the file in the
// per-test output dir that ships in the playwright-traces artifact uploaded by
// .github/workflows/e2e.yml on failure. The `body` form of testInfo.attach
// didn't reliably persist for the `list` reporter; the path round-trip does.
async function captureAttachment(page: Page, testInfo: TestInfo, fileName: string): Promise<void> {
  const dest = testInfo.outputPath(fileName)
  await page.screenshot({ path: dest, fullPage: true })
  await testInfo.attach(fileName, { path: dest, contentType: 'image/png' })
}
