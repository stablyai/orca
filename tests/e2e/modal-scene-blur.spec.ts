import { test, expect } from './helpers/orca-app'
import { openSidebarProjectDialog } from './helpers/sidebar-project-dialog'

test.use({ seedTestRepo: false, orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

for (const theme of ['dark', 'light'] as const) {
  test(`modal surfaces blur the live scene and stay sharp (${theme})`, async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const windows = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused()
      }))
    )
    expect(windows.every((window) => !window.visible && !window.focused)).toBe(true)
    await orcaPage.evaluate(async (theme) => {
      await window.__store?.getState().updateSettings({ theme, uiLanguage: 'en' })
    }, theme)

    const scene = orcaPage.locator('.app-layout > :first-child')
    await expect(scene).toHaveCSS('filter', 'none')
    await openSidebarProjectDialog(orcaPage)
    await expect(scene).toHaveCSS('filter', 'blur(2px)')
    await expect(orcaPage.locator('.app-layout')).toHaveCSS('filter', 'none')
    const dialog = orcaPage.getByRole('dialog', { name: /Add a project/i })
    await expect(dialog).toHaveCSS('filter', 'none')
    await expect(dialog).toHaveCSS('backdrop-filter', 'none')
    await expect(orcaPage.locator('[data-slot="dialog-overlay"]')).toHaveCSS(
      'backdrop-filter',
      'none'
    )
    await orcaPage.screenshot({ path: testInfo.outputPath(`dialog-blur-${theme}.png`) })
    await orcaPage.keyboard.press('Escape')
    await expect(scene).toHaveCSS('filter', 'none')

    await orcaPage.getByRole('button', { name: 'Search worktrees and browser tabs' }).click()
    const palette = orcaPage.locator('[data-slot="command-dialog-content"]')
    await expect(palette).toBeVisible()
    await expect(scene).toHaveCSS('filter', 'blur(2px)')
    await expect(palette).toHaveCSS('filter', 'none')
    await expect(palette).toHaveCSS('backdrop-filter', 'none')
    await orcaPage.keyboard.press('Escape')
    await expect(scene).toHaveCSS('filter', 'none')
  })
}

test('Space window dialogs blur their scene and release it on close', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const spaceWindow = electronApp.waitForEvent('window')
  await orcaPage.evaluate(async () => {
    await window.api.workspaceSpace.openWindow?.()
  })
  const spacePage = await spaceWindow
  await spacePage.waitForFunction(() => Boolean(window.__store))
  const scene = spacePage.locator('.app-layout > :first-child')
  await expect(scene).toHaveCSS('filter', 'none')
  await spacePage.evaluate(() => {
    window.__store?.getState().openModal('preserved-branch-review', {
      branches: [{ worktreeId: 'blur-preview', branchName: 'preview' }]
    })
  })
  const dialog = spacePage.getByRole('dialog', { name: 'Review kept branches' })
  await expect(dialog).toBeVisible()
  await expect(scene).toHaveCSS('filter', 'blur(2px)')
  await expect(dialog).toHaveCSS('filter', 'none')
  await expect(dialog).toHaveCSS('backdrop-filter', 'none')
  const windows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  )
  expect(windows.every((window) => !window.visible && !window.focused)).toBe(true)
  await spacePage.screenshot({ path: testInfo.outputPath('space-dialog-blur.png') })
  await spacePage.keyboard.press('Escape')
  await expect(scene).toHaveCSS('filter', 'none')
})

test.describe('onboarding scene blur', () => {
  test.use({ dismissOnboarding: false })

  test('onboarding stays sharp until a nested confirmation opens', async ({ orcaPage }) => {
    const scene = orcaPage.locator('.app-layout > :first-child')
    const onboarding = orcaPage.locator('[data-onboarding-overlay]')
    await expect(onboarding).toBeVisible()
    await expect(scene).toHaveCSS('filter', 'blur(2px)')
    await expect(onboarding).toHaveCSS('filter', 'none')
    await expect(onboarding).toHaveCSS('backdrop-filter', 'none')
    await onboarding.getByRole('button').first().focus()
    await orcaPage.keyboard.press('Escape')
    const confirmation = orcaPage.getByRole('dialog', { name: /Skip onboarding\?/i })
    await expect(confirmation).toBeVisible()
    await expect(confirmation).toHaveCSS('filter', 'none')
    await expect(onboarding).toHaveCSS('filter', 'blur(2px)')
    await confirmation.getByRole('button', { name: /No, keep going/i }).click()
    await expect(onboarding).toHaveCSS('filter', 'none')
    await expect(scene).toHaveCSS('filter', 'blur(2px)')
  })

  test('onboarding render recovery stays within the viewport', async ({ orcaPage }, testInfo) => {
    await expect(orcaPage.locator('[data-onboarding-overlay]')).toBeVisible()
    await orcaPage.evaluate(async () => {
      const onboarding = await window.api.onboarding.get()
      Object.defineProperty(onboarding, 'lastCompletedStep', {
        get() {
          throw new Error('Injected onboarding render failure')
        }
      })
      window.dispatchEvent(new CustomEvent('orca:onboarding-reopened', { detail: onboarding }))
    })

    const crashReport = orcaPage.getByRole('dialog').filter({
      has: orcaPage.getByRole('heading', { name: 'Orca hit a recoverable UI error' })
    })
    await crashReport.getByRole('button', { name: 'Close', exact: true }).click()
    const recovery = orcaPage.getByRole('alert').filter({ hasText: 'Onboarding hit an error.' })
    const retry = recovery.getByRole('button', { name: 'Retry', exact: true })
    await expect(retry).toBeInViewport()
    await orcaPage.screenshot({ path: testInfo.outputPath('onboarding-render-recovery.png') })

    await orcaPage.evaluate(async () => {
      window.dispatchEvent(
        new CustomEvent('orca:onboarding-reopened', { detail: await window.api.onboarding.get() })
      )
    })
    await retry.click()
    await expect(recovery).toHaveCount(0)
    await expect(orcaPage.locator('[data-onboarding-overlay]')).toBeVisible()
    await expect(orcaPage.locator('.app-layout > :first-child')).toHaveCSS('filter', 'blur(2px)')
  })
})
