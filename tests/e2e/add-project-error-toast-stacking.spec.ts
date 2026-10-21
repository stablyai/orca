import path from 'node:path'
import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { openSidebarProjectDialog } from './helpers/sidebar-project-dialog'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'

test.use({
  seedTestRepo: false,
  testRepoPath: '',
  orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' }
})

async function assertHiddenIsolation(app: ElectronApplication, testInfo: TestInfo, name: string) {
  const isolation = await app.evaluate(({ app, BrowserWindow }) => ({
    home: app.getPath('home'),
    expectedHome: process.env.ORCA_E2E_HOME_DIR,
    appPath: app.getAppPath(),
    background: process.env.ORCA_BACKGROUND_LAUNCH,
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  expect(isolation.home).toBe(isolation.expectedHome)
  expect(isolation.background).toBe('1')
  expect(isolation.appPath).toContain(process.cwd())
  expect(isolation.windows.every((window) => !window.visible && !window.focused)).toBe(true)
  await testInfo.attach(name, { body: JSON.stringify(isolation), contentType: 'application/json' })
  return isolation.home
}

for (const theme of ['dark', 'light'] as const) {
  test(`invalid host project path stays readable over its dialog (${theme})`, async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const hostHome = await assertHiddenIsolation(electronApp, testInfo, 'host-isolation')
    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    const client = await launchPairedElectronClient(offer, testInfo, 'Disposable host', {
      extraEnv: { ORCA_BACKGROUND_LAUNCH: '1' }
    })
    try {
      await assertHiddenIsolation(client.app, testInfo, 'client-isolation')
      const page = client.page
      await page.evaluate(async (theme) => {
        await window.__store?.getState().updateSettings({ theme })
      }, theme)
      await openSidebarProjectDialog(page)
      const dialog = page.getByRole('dialog', { name: /Add a project/i })
      const hostPicker = dialog.getByRole('combobox')
      await hostPicker.click()
      await page.locator('[cmdk-item]').filter({ hasText: 'Disposable host' }).click()
      await dialog.getByRole('button', { name: /Browse folder|Browse host/i }).click()
      await page
        .getByRole('dialog', { name: /Browse host filesystem/i })
        .getByRole('button', { name: 'Cancel', exact: true })
        .click()
      const pathField = page.locator('#server-project-path')
      const missingPath = path.join(hostHome, 'missing-project')
      await pathField.fill(missingPath)
      await page.getByRole('button', { name: 'Add Git Project' }).click()
      const toast = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'Cannot open folder on selected runtime' })
        .first()
      await expect(toast).toBeVisible()
      await expect(pathField).toHaveValue(missingPath)
      await expect(page.getByRole('dialog', { name: /Open host project/i })).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath(`toast-over-dialog-${theme}.png`),
        animations: 'disabled'
      })
      const layers = await toast.evaluate((element) => {
        const overlay = document.querySelector('[data-slot="dialog-overlay"]')
        const toaster = element.closest('[data-sonner-toaster]')
        if (!overlay || !toaster) {
          throw new Error('Missing modal/toast layers')
        }
        return {
          toast: Number(getComputedStyle(toaster).zIndex),
          overlay: Number(getComputedStyle(overlay).zIndex),
          pointerEvents: getComputedStyle(element).pointerEvents
        }
      })
      await testInfo.attach('layers', {
        body: JSON.stringify(layers),
        contentType: 'application/json'
      })
      expect(layers.toast, 'dialog overlay covers the project error').toBeGreaterThan(
        layers.overlay
      )
      expect(layers.pointerEvents).toBe('none')
      await pathField.click()
      // Radix still owns pointer/focus containment; a visible toast must not steal the form.
      await expect(
        toast.locator('[data-close-button]').click({ trial: true, timeout: 300 })
      ).rejects.toThrow()
      await expect(pathField).toHaveValue(missingPath)
      expect(await pathField.evaluate((input) => input === document.activeElement)).toBe(true)

      // A real action-toast renderer, fed a synthetic notification in this disposable client only.
      await client.app.evaluate(({ ipcMain, BrowserWindow }) => {
        ipcMain.removeHandler('mobile:consumePendingUnpairedDeviceAuthFailure')
        ipcMain.handle('mobile:consumePendingUnpairedDeviceAuthFailure', () => true)
        BrowserWindow.getAllWindows()[0].webContents.send('mobile:unpairedDeviceAuthFailure')
      })
      const actionToast = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'A device tried to connect but is not paired' })
      const action = actionToast.getByRole('button', { name: 'Open Mobile Settings' })
      await expect(action).toBeVisible()
      await expect(action.click({ trial: true, timeout: 300 })).rejects.toThrow()
      await expect(pathField).toHaveValue(missingPath)
      expect(await pathField.evaluate((input) => input === document.activeElement)).toBe(true)

      // Credential prompts deliberately use a higher tier; this visibility fix does not cross it.
      await page.evaluate(() =>
        window.__store?.getState().enqueueSshCredentialRequest({
          requestId: 'toast-layer-fixture',
          targetId: 'Simulated SSH prompt',
          kind: 'password',
          detail: 'Layering fixture only'
        })
      )
      await expect(page.getByRole('dialog', { name: 'SSH Password' })).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath(`higher-modal-residual-${theme}.png`),
        animations: 'disabled'
      })
      expect(
        await page
          .locator('[data-slot="dialog-overlay"]')
          .evaluateAll((overlays) =>
            Math.max(...overlays.map((overlay) => Number(getComputedStyle(overlay).zIndex)))
          )
      ).toBe(140)
      await page.evaluate(() =>
        window.__store?.getState().removeSshCredentialRequest('toast-layer-fixture')
      )
      await expect(pathField).toHaveValue(missingPath)
      await page
        .getByRole('dialog', { name: /Open host project/i })
        .getByRole('button', { name: 'Close', exact: true })
        .click()
      await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0)
      const toaster = page.locator('[data-sonner-toaster]')
      await expect(toaster).toHaveCSS('z-index', '40')
      await toast.locator('[data-close-button]').click()
      await expect(toast).toBeHidden()

      await page.evaluate(async () => {
        await window.__store?.getState().updateSettings({ experimentalAgentDashboardPopout: true })
      })
      await page.evaluate(() => window.__store?.getState().setAgentDashboardDrawerOpen(true))
      await expect(page.locator('[data-agent-dashboard-sheet]')).toBeVisible()
      await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0)
      await expect(toaster).toHaveCSS('z-index', '40')
      await page.screenshot({
        path: testInfo.outputPath(`nonmodal-drawer-${theme}.png`),
        animations: 'disabled'
      })
      await page.evaluate(() => window.__store?.getState().setAgentDashboardDrawerOpen(false))
      // Scroll-lock is also used by selects and menus and must not by itself lift notifications.
      await page.evaluate(() => document.body.setAttribute('data-scroll-locked', '1'))
      await expect(toaster).toHaveCSS('z-index', '40')
      await page.evaluate(() => document.body.removeAttribute('data-scroll-locked'))
      await action.click()
      await expect(page.getByPlaceholder('Search settings')).toBeVisible()
      await assertHiddenIsolation(client.app, testInfo, 'client-final-isolation')
      await assertHiddenIsolation(electronApp, testInfo, 'host-final-isolation')
      expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
      expect(await orcaPage.evaluate(() => window.api.repos.list())).toEqual([])
    } finally {
      await client.dispose()
    }
  })
}
