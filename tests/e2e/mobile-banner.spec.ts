import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForSessionReady,
  waitForActiveWorktree
} from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

// #1532: drive production fit/driver IPC → renderer state → banner; DOM assertions cover mounting/dismissal and screenshots expose terminal-obscuring scrims.

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

  // Send the auto-subscribe fit/driver events that main emits to mount the loud overlay.
  await sendMobileSubscribeIpc(electronApp, { ptyId, cols: 45, rows: 20 })

  await expect(overlay).toBeVisible({ timeout: 15_000 })
  await expect(overlay).toContainText(/your phone is in control/i)
  await expectExpandedOverlayLeavesPaneReadable(orcaPage, ptyId)

  const takeBackThisTerminal = overlay.getByRole('button', { name: /^take back$/i })
  const takeBackAllTerminals = overlay.getByRole('button', { name: /^take back all$/i })
  const collapse = overlay.getByRole('button', { name: /^minimize$/i })
  await expect(takeBackThisTerminal).toBeVisible()
  await expect(takeBackAllTerminals).toBeVisible()
  await expect(collapse).toBeVisible()

  await captureAttachment(orcaPage, testInfo, 'overlay-loud.png')

  // Minimize keeps the lock while showing a compact take-back chip over live output.
  await collapse.click()
  await expect(overlay).toContainText(/phone driving/i)
  await expect(overlay.getByRole('button', { name: /take back/i })).toBeVisible()
  await expect(overlay).not.toContainText(/your phone is in control/i)
  await expectChipIsCompactInPane(orcaPage, ptyId)

  await captureAttachment(orcaPage, testInfo, 'overlay-collapsed.png')

  await overlay.getByRole('button', { name: /phone driving/i }).click()
  await expect(overlay).toContainText(/your phone is in control/i)
  await expectExpandedOverlayLeavesPaneReadable(orcaPage, ptyId)

  await collapse.click()
  await expect(overlay).not.toContainText(/your phone is in control/i)

  // Mirror main’s desktop-fit and driver events after proving Take back called the production IPC.
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

  // After disconnect, idle driver plus held phone fit stays loud because no mobile output remains to watch.
  await sendHeldPhoneFitIpc(electronApp, { ptyId, cols: 45, rows: 20 })

  await expect(overlay).toBeVisible({ timeout: 15_000 })
  await expect(overlay).toContainText(/still sized for your phone/i)
  await expect(overlay.getByRole('button', { name: /^restore$/i })).toBeVisible()
  await expect(overlay.getByRole('button', { name: /^restore all$/i })).toBeVisible()
  await expect(overlay.getByRole('button', { name: /^minimize$/i })).toHaveCount(0)
  await expect(overlay.getByRole('button', { name: /take back/i })).toHaveCount(0)
  await expectExpandedOverlayLeavesPaneReadable(orcaPage, ptyId)

  await captureAttachment(orcaPage, testInfo, 'overlay-held-fit.png')

  await overlay.getByRole('button', { name: /^restore$/i }).click()
  await expectRestoreTerminalFitCalls(electronApp, [ptyId])
  await sendDesktopRestoreIpc(electronApp, { ptyId })
  await expect(overlay).toBeHidden({ timeout: 15_000 })
})

test('restore refits the active restored pane', async ({ orcaPage, electronApp }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await installRestoreTerminalFitAutoRestoreRecorder(electronApp)

  await sendHeldPhoneFitIpc(electronApp, { ptyId, cols: 1, rows: 20 })
  await expect(orcaPage.locator('.mobile-driver-banner')).toHaveCount(1, { timeout: 15_000 })
  await expect
    .poll(() => getPaneTerminalCols(orcaPage, ptyId), {
      message: 'test harness should hold the active pane in the bad narrow state'
    })
    .toBeLessThanOrEqual(2)

  await orcaPage
    .locator(`[data-pty-id="${ptyId}"] .mobile-driver-banner`)
    .getByRole('button', { name: /^restore$/i })
    .click()

  await expectRestoreTerminalFitCalls(electronApp, [ptyId])
  await expect
    .poll(() => getPaneTerminalCols(orcaPage, ptyId), {
      timeout: 5_000,
      message: 'Restore should refit the active restored pane'
    })
    .toBeGreaterThan(20)
})

test('restore all refits non-focused restored terminal panes', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await splitActiveTerminalPane(orcaPage, 'vertical')
  const ptyIds = await waitForVisiblePanePtyIds(orcaPage, 2)
  const focusPtyId = await waitForActivePanePtyId(orcaPage)
  const inactivePtyId = ptyIds.find((ptyId) => ptyId !== focusPtyId)
  if (!inactivePtyId || !focusPtyId) {
    throw new Error('Expected two visible terminal panes with PTY bindings')
  }
  await installRestoreTerminalFitAutoRestoreRecorder(electronApp)

  await sendHeldPhoneFitIpc(electronApp, { ptyId: inactivePtyId, cols: 45, rows: 20 })
  await sendHeldPhoneFitIpc(electronApp, { ptyId: focusPtyId, cols: 45, rows: 20 })
  await expect(orcaPage.locator('.mobile-driver-banner')).toHaveCount(2, { timeout: 15_000 })

  await forcePaneToOneColumn(orcaPage, inactivePtyId)
  await expect
    .poll(() => getPaneTerminalCols(orcaPage, inactivePtyId), {
      message: 'test harness should force the non-focused pane into the bad narrow state'
    })
    .toBeLessThanOrEqual(2)

  await orcaPage
    .locator(`[data-pty-id="${focusPtyId}"] .mobile-driver-banner`)
    .getByRole('button', { name: /^restore all$/i })
    .click()

  await expectRestoreTerminalFitCallSet(electronApp, [inactivePtyId, focusPtyId])
  await expect
    .poll(() => getPaneTerminalCols(orcaPage, inactivePtyId), {
      timeout: 5_000,
      message: 'Restore all should refit the non-focused restored pane'
    })
    .toBeGreaterThan(20)
})

test('restore all recovers a hidden workspace held at narrow terminal geometry', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  const firstWorktreeId = await waitForActiveWorktree(orcaPage)
  const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
    (worktreeId) => worktreeId !== firstWorktreeId
  )
  test.skip(!secondWorktreeId, 'hidden-workspace restore repro needs the seeded secondary worktree')
  if (!secondWorktreeId) {
    return
  }

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const hiddenWorkspacePtyId = await waitForActivePanePtyId(orcaPage)
  await sendHeldPhoneFitIpc(electronApp, { ptyId: hiddenWorkspacePtyId, cols: 45, rows: 20 })
  await expect(orcaPage.locator('.mobile-driver-banner')).toHaveCount(1, { timeout: 15_000 })

  await forcePaneToOneColumnAndSwitchWorktree(orcaPage, hiddenWorkspacePtyId, secondWorktreeId)
  await expect
    .poll(() => getActiveWorktreeId(orcaPage), {
      timeout: 5_000,
      message: 'second worktree should become active before restore-all'
    })
    .toBe(secondWorktreeId)
  await expect
    .poll(() => getPaneTerminalCols(orcaPage, hiddenWorkspacePtyId), {
      message: 'test harness should hold workspace 1 in the bad narrow state'
    })
    .toBeLessThanOrEqual(2)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const activeWorkspacePtyId = await waitForActivePanePtyId(orcaPage)
  await installRestoreTerminalFitAutoRestoreRecorder(electronApp)
  await sendHeldPhoneFitIpc(electronApp, { ptyId: activeWorkspacePtyId, cols: 45, rows: 20 })
  await expect(
    orcaPage.locator(`[data-pty-id="${activeWorkspacePtyId}"] .mobile-driver-banner`)
  ).toBeVisible({ timeout: 15_000 })

  await orcaPage
    .locator(`[data-pty-id="${activeWorkspacePtyId}"] .mobile-driver-banner`)
    .getByRole('button', { name: /^restore all$/i })
    .click()

  await expectRestoreTerminalFitCallSet(electronApp, [hiddenWorkspacePtyId, activeWorkspacePtyId])

  await switchToWorktree(orcaPage, firstWorktreeId)
  await expect
    .poll(() => getActiveWorktreeId(orcaPage), {
      timeout: 5_000,
      message: 'first worktree should become active after restore-all'
    })
    .toBe(firstWorktreeId)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await expect
    .poll(() => getPaneTerminalCols(orcaPage, hiddenWorkspacePtyId), {
      timeout: 5_000,
      message: 'Restore all should refit the hidden workspace when it becomes visible'
    })
    .toBeGreaterThan(20)
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
    // No real subscriber exists: intercept only main’s restore handler to verify the production channel/payload, then mirror its events.
    ipcMain.removeHandler('runtime:restoreTerminalFit')
    ipcMain.handle('runtime:restoreTerminalFit', (_event, args: { ptyId: string }) => {
      testGlobal.__mobileBannerRestoreCalls?.push(args.ptyId)
      return { restored: true }
    })
  })
}

async function installRestoreTerminalFitAutoRestoreRecorder(
  electronApp: ElectronApplication
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, ipcMain }) => {
    const testGlobal = globalThis as typeof globalThis & {
      __mobileBannerRestoreCalls?: string[]
    }
    testGlobal.__mobileBannerRestoreCalls = []
    // Production clears the fit override and restores desktop control; mirror both events.
    ipcMain.removeHandler('runtime:restoreTerminalFit')
    ipcMain.handle('runtime:restoreTerminalFit', (_event, args: { ptyId: string }) => {
      testGlobal.__mobileBannerRestoreCalls?.push(args.ptyId)
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('runtime:terminalFitOverrideChanged', {
          ptyId: args.ptyId,
          mode: 'desktop-fit',
          cols: 0,
          rows: 0
        })
        win.webContents.send('runtime:terminalDriverChanged', {
          ptyId: args.ptyId,
          driver: { kind: 'desktop' }
        })
      }
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

async function expectRestoreTerminalFitCallSet(
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
      { message: 'restore all should invoke the production restore channel for each PTY' }
    )
    .toEqual(expect.arrayContaining(expected))
}

async function waitForVisiblePanePtyIds(page: Page, expectedCount: number): Promise<string[]> {
  let ptyIds: string[] = []
  await expect
    .poll(
      async () => {
        ptyIds = await page.evaluate(() => {
          const state = window.__store?.getState()
          const tabId = state?.activeTabId
          const manager = tabId ? window.__paneManagers?.get(tabId) : null
          return (manager?.getPanes?.() ?? [])
            .map((pane) => pane.container?.dataset?.ptyId ?? null)
            .filter((ptyId): ptyId is string => Boolean(ptyId))
        })
        return ptyIds.length
      },
      {
        timeout: 15_000,
        message: `Expected ${expectedCount} visible panes with PTY bindings`
      }
    )
    .toBe(expectedCount)
  return ptyIds
}

async function forcePaneToOneColumn(page: Page, ptyId: string): Promise<void> {
  await page.evaluate((targetPtyId) => {
    for (const manager of window.__paneManagers?.values?.() ?? []) {
      const pane = manager
        .getPanes?.()
        .find((candidate) => candidate.container.dataset.ptyId === targetPtyId)
      if (pane) {
        pane.terminal.resize(1, Math.max(8, pane.terminal.rows))
        pane.terminal.refresh(0, pane.terminal.rows - 1)
        return
      }
    }
    throw new Error(`No pane found for PTY ${targetPtyId}`)
  }, ptyId)
}

async function forcePaneToOneColumnAndSwitchWorktree(
  page: Page,
  ptyId: string,
  worktreeId: string
): Promise<void> {
  await page.evaluate(
    ({ targetPtyId, targetWorktreeId }) => {
      for (const manager of window.__paneManagers?.values?.() ?? []) {
        const pane = manager
          .getPanes?.()
          .find((candidate) => candidate.container.dataset.ptyId === targetPtyId)
        if (pane) {
          // Reproduce phone-sized xterm layout inherited while the workspace is hidden.
          pane.terminal.resize(1, Math.max(8, pane.terminal.rows))
          pane.terminal.refresh(0, pane.terminal.rows - 1)
          window.__store?.getState().setActiveWorktree(targetWorktreeId)
          return
        }
      }
      throw new Error(`No pane found for PTY ${targetPtyId}`)
    },
    { targetPtyId: ptyId, targetWorktreeId: worktreeId }
  )
}

async function getPaneTerminalCols(page: Page, ptyId: string): Promise<number> {
  return page.evaluate((targetPtyId) => {
    for (const manager of window.__paneManagers?.values?.() ?? []) {
      const pane = manager
        .getPanes?.()
        .find((candidate) => candidate.container.dataset.ptyId === targetPtyId)
      if (pane) {
        return pane.terminal.cols
      }
    }
    return 0
  }, ptyId)
}

async function expectExpandedOverlayLeavesPaneReadable(page: Page, ptyId: string): Promise<void> {
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
          const style = getComputedStyle(overlay)
          const hasTransparentBackground =
            style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent'
          const webkitBackdropFilter = (
            style as CSSStyleDeclaration & { webkitBackdropFilter?: string }
          ).webkitBackdropFilter
          const hasNoBackdropFilter =
            (style.backdropFilter === 'none' || style.backdropFilter === '') &&
            (webkitBackdropFilter === undefined ||
              webkitBackdropFilter === '' ||
              webkitBackdropFilter === 'none')
          const paneBox = pane.getBoundingClientRect()
          const overlayBox = overlay.getBoundingClientRect()
          return (
            hasTransparentBackground &&
            hasNoBackdropFilter &&
            Math.abs(overlayBox.left - paneBox.left) <= 2 &&
            Math.abs(overlayBox.top - paneBox.top) <= 2 &&
            overlayBox.width >= paneBox.width - 2 &&
            overlayBox.height >= paneBox.height - 2
          )
        }, ptyId),
      { message: 'expanded overlay should not dim or blur the terminal pane' }
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

// Attach via outputPath so list-reporter screenshots reliably reach playwright-traces artifacts.
async function captureAttachment(page: Page, testInfo: TestInfo, fileName: string): Promise<void> {
  const dest = testInfo.outputPath(fileName)
  await page.screenshot({ path: dest, fullPage: true })
  await testInfo.attach(fileName, { path: dest, contentType: 'image/png' })
}
