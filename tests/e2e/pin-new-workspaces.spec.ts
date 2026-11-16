import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { waitForSessionReady } from './helpers/store'

async function openPinSetting(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  const section = page.locator('section[data-settings-section="appearance"]')
  const advanced = section.getByRole('button', { name: 'Advanced', exact: true })
  if ((await advanced.getAttribute('aria-expanded')) !== 'true') {
    await advanced.click()
  }
  await expect(section.getByRole('switch', { name: 'Pin new workspaces' })).toBeVisible()
}

async function createWorkspace(page: Page, name: string): Promise<void> {
  await openSidebarWorkspaceComposer(page)
  const dialog = page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder(/Type a name/i).fill(name)
  await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
}

test('pins UI-created workspaces only after the setting is enabled', async ({
  orcaPage
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  await openPinSetting(orcaPage)
  const pinSetting = orcaPage.getByRole('switch', { name: 'Pin new workspaces' })
  await expect(pinSetting).toHaveAttribute('aria-checked', 'false')
  await orcaPage.getByRole('button', { name: 'Close settings' }).click()

  await createWorkspace(orcaPage, 'pin-setting-off')
  const offRow = orcaPage.getByRole('option').filter({ hasText: 'pin-setting-off' })
  await expect(offRow).toBeVisible({ timeout: 30_000 })
  await expect(offRow).not.toHaveAttribute('data-worktree-section-key', 'pinned')

  await openPinSetting(orcaPage)
  await pinSetting.click()
  await expect(pinSetting).toHaveAttribute('aria-checked', 'true')
  await pinSetting.screenshot({ path: testInfo.outputPath('pin-setting-on.png') })
  await orcaPage.getByRole('button', { name: 'Close settings' }).click()

  await createWorkspace(orcaPage, 'pin-setting-on')
  const onRow = orcaPage.getByRole('option').filter({ hasText: 'pin-setting-on' })
  await expect(onRow).toBeVisible({ timeout: 30_000 })
  await expect(onRow).toHaveAttribute('data-worktree-section-key', 'pinned')
  await onRow.screenshot({ path: testInfo.outputPath('created-pinned-workspace.png') })

  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await expect(onRow).toBeVisible({ timeout: 30_000 })
  await expect(onRow).toHaveAttribute('data-worktree-section-key', 'pinned')
  await openPinSetting(orcaPage)
  await expect(pinSetting).toHaveAttribute('aria-checked', 'true')
})
