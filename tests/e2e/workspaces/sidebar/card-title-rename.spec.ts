import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'

test.beforeEach(async ({ orcaPage }) => {
  await orcaPage.setViewportSize({ width: 1440, height: 900 })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  // New-style cards wrap the title in the details hover.
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettings({ experimentalNewWorktreeCardStyle: true })
  )
})

async function renameByDoubleClick(page: Page, from: string, to: string): Promise<void> {
  const sidebar = page.locator('#workspace-list-region')
  await sidebar.getByText(from, { exact: true }).first().dblclick()
  const input = page.getByRole('textbox', { name: 'Rename workspace' })
  await expect(input).toBeFocused()
  await input.fill(to)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(sidebar.getByText(to, { exact: true })).toBeVisible()
}

// Renaming shuts the details hover; dropping it instead would remount the title and end the rename.
test('double-click renames the active new-style card', async ({ orcaPage }) => {
  await renameByDoubleClick(orcaPage, 'main', 'renamed-active-card')
})

// The first click wakes a sleeping workspace; un-dimming it must not remount the title mid-rename.
test('double-click renames a sleeping new-style card', async ({ orcaPage }) => {
  const sidebar = orcaPage.locator('#workspace-list-region')
  await expect(
    sidebar.locator('[data-worktree-sleeping-dim]').getByText('e2e-secondary', { exact: true })
  ).toBeVisible()
  await renameByDoubleClick(orcaPage, 'e2e-secondary', 'renamed-sleeping-card')
})
