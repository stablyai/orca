import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test('held workspace modifiers reveal numbers matching the sidebar targets', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('name')
    state.setShowSleepingWorkspaces(true)
  })
  const rows = orcaPage.locator('[data-worktree-sidebar] [role="option"][data-worktree-id]')
  await expect(rows.first()).toBeVisible()
  const hints = orcaPage.locator('[data-workspace-shortcut-hint]')
  await expect(hints).toHaveCount(0)
  await orcaPage
    .locator('[data-worktree-sidebar]')
    .screenshot({ path: testInfo.outputPath('before.png') })

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await orcaPage.keyboard.down(modifier)
  try {
    await expect(hints.first()).toHaveText('1')
    await expect(rows.nth(1).locator('[data-workspace-shortcut-hint]')).toHaveText('2')
    await orcaPage
      .locator('[data-worktree-sidebar]')
      .screenshot({ path: testInfo.outputPath('after.png') })
    await orcaPage.keyboard.press('2')
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'page')
  } finally {
    await orcaPage.keyboard.up(modifier)
  }
  await expect(hints).toHaveCount(0)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
