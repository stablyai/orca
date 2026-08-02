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

// Why: regression coverage for the mobile-presence-lock UX (PR #1532). Strong
// DOM assertions guard the "doesn't mount / doesn't dismiss" regression class;
// visual assertions keep the notice from reintroducing a full-pane scrim/blur
// over the live terminal stream. Screenshots ride in the playwright-traces
// artifact upload so reviewers can eyeball the rendering on a failed run.
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
  await expect(overlay).toContainText(/from your phone/i)
  await expect(overlay).toContainText(/your phone is in control/i)
  await expectExpandedOverlayLeavesPaneReadable(orcaPage, ptyId)

  const takeBackThisTerminal = overlay.getByRole('button', { name: /take back this terminal/i })
  const takeBackAllTerminals = overlay.getByRole('button', { name: /take back all terminals/i })
  const collapse = overlay.getByRole('button', { name: /^collapse$/i })
  await expect(takeBackThisTerminal).toBeVisible()
  await expect(takeBackAllTerminals).toBeVisible()
  await expect(collapse).toBeVisible()

  await captureAttachment(orcaPage, testInfo, 'overlay-loud.png')

  // Click Collapse → loud overlay swaps to the corner chip while the lock stays
  // engaged. The user can keep watching live mobile output while the chip
  // remains a one-click escape hatch back to desktop control.
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

  // Take back from the chip dismisses the overlay. The button calls
  // runtime.restoreTerminalFit via IPC; main responds with desktop-fit + desktop
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
  await expect(overlay).toContainText(/from your phone/i)
  await expect(overlay).toContainText(/your phone left this at phone size/i)
  await expect(overlay).toContainText(/all terminals your phone left at phone size/i)
  await expect(overlay.getByRole('button', { name: /restore this terminal/i })).toBeVisible()
  await expect(overlay.getByRole('button', { name: /restore all terminals/i })).toBeVisible()
  await expect(overlay.getByRole('button', { name: /^collapse$/i })).toHaveCount(0)
  await expect(overlay.getByRole('button', { name: /take back/i })).toHaveCount(0)
  await expectExpandedOverlayLeavesPaneReadable(orcaPage, ptyId)

  await captureAttachment(orcaPage, testInfo, 'overlay-held-fit.png')

  await overlay.getByRole('button', { name: /restore this terminal/i }).click()
  await expectRestoreTerminalFitCalls(electronApp, [ptyId])
  await sendDesktopRestoreIpc(electronApp, { ptyId })
  await expect(overlay).toBeHidden({ timeout: 15_000 })
})

test('restore this terminal refits the active restored pane', async ({ orcaPage, electronApp }) => {
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
    .getByRole('button', { name: /restore this terminal/i })
    .click()

  await expectRestoreTerminalFitCalls(electronApp, [ptyId])
  await expect
    .poll(() => getPaneTerminalCols(orcaPage, ptyId), {
      timeout: 5_000,
      message: 'Restore this terminal should refit the active restored pane'
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
    .getByRole('button', { name: /restore all terminals/i })
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
    .getByRole('button', { name: /restore all terminals/i })
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

async function installRestoreTerminalFitAutoRestoreRecorder(
  electronApp: ElectronApplication
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, ipcMain }) => {
    const testGlobal = globalThis as typeof globalThis & {
      __mobileBannerRestoreCalls?: string[]
    }
    testGlobal.__mobileBannerRestoreCalls = []
    // Why: the production restore path sets desktop control after clearing the
    // fit override, so this harness mirrors both renderer-facing events.
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
          // Why: the repro needs the desktop surface to inherit a phone-sized
          // xterm layout after the workspace is no longer visible.
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

// Why: writing the screenshot to testInfo.outputPath() lands the file in the
// per-test output dir that ships in the playwright-traces artifact uploaded by
// .github/workflows/e2e.yml on failure. The `body` form of testInfo.attach
// didn't reliably persist for the `list` reporter; the path round-trip does.
async function captureAttachment(page: Page, testInfo: TestInfo, fileName: string): Promise<void> {
  const dest = testInfo.outputPath(fileName)
  await page.screenshot({ path: dest, fullPage: true })
  await testInfo.attach(fileName, { path: dest, contentType: 'image/png' })
}
