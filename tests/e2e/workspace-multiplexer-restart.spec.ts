import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

async function selectLayout(page: Page, name: string): Promise<void> {
  await page.locator('[data-workspace-multiplexer-switcher]').click()
  await page.getByRole('menuitemradio', { name, exact: true }).click()
}

test('multiple multiplexer layouts and deletion survive app restarts', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    let launched = await session.launch()
    app = launched.app
    let page = launched.page
    await waitForSessionReady(page)
    await page.evaluate(() => window.__store?.getState().updateSettings({ uiLanguage: 'en' }))
    await attachRepoAndOpenTerminal(page, testRepoPath)
    await page.locator('[data-workspace-multiplexer-trigger]').click()
    await page
      .locator('[data-workspace-multiplexer-page] > header')
      .getByRole('button', { name: 'Add workspace' })
      .click()
    await page.locator('[data-workspace-multiplexer-worktree-id]').first().click()
    const tile = page.locator('[data-workspace-multiplexer-slot-id]')
    await expect(tile).toHaveCount(1)
    const slotId = await tile.getAttribute('data-workspace-multiplexer-slot-id')
    await page.locator('[data-workspace-multiplexer-switcher]').click()
    await page.getByRole('menuitem', { name: 'Add multiplexer', exact: true }).click()
    await expect(page.locator('[data-workspace-multiplexer-switcher]')).toHaveText('Multiplexer 2')
    await expect(tile).toHaveCount(0)
    await selectLayout(page, 'Multiplexer 1')
    await expect(tile).toHaveAttribute('data-workspace-multiplexer-slot-id', slotId!)
    await selectLayout(page, 'Multiplexer 2')
    await page.screenshot({ path: 'output/playwright/multiplexer-collections.png' })
    await session.close(app)
    app = null

    launched = await session.launch()
    app = launched.app
    page = launched.page
    await waitForSessionReady(page)
    await expect(page.locator('[data-workspace-multiplexer-switcher]')).toHaveText('Multiplexer 2')
    await expect(page.locator('[data-workspace-multiplexer-slot-id]')).toHaveCount(0)
    await selectLayout(page, 'Multiplexer 1')
    await expect(page.locator('[data-workspace-multiplexer-slot-id]')).toHaveAttribute(
      'data-workspace-multiplexer-slot-id',
      slotId!
    )
    await expect(page.locator('[data-workspace-multiplexer-slot-id] .xterm:visible')).toHaveCount(1)
    await selectLayout(page, 'Multiplexer 2')
    await page.locator('[data-workspace-multiplexer-switcher]').click()
    await page.getByRole('menuitem', { name: 'Delete multiplexer', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete multiplexer', exact: true })
      .click()
    await expect(page.locator('[data-workspace-multiplexer-switcher]')).toHaveText('Multiplexer 1')
    await expect(page.locator('[data-workspace-multiplexer-slot-id] .xterm:visible')).toHaveCount(1)
    await session.close(app)
    app = null

    launched = await session.launch()
    app = launched.app
    page = launched.page
    await waitForSessionReady(page)
    await expect(page.locator('[data-workspace-multiplexer-switcher]')).toHaveText('Multiplexer 1')
    await page.locator('[data-workspace-multiplexer-switcher]').click()
    await expect(page.getByRole('menuitemradio')).toHaveCount(1)
    await expect(page.getByRole('menuitemradio', { name: 'Multiplexer 1' })).toBeVisible()
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
