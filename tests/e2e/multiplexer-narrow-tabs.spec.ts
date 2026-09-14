import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'

test('narrow multiplexer panes keep both terminal tabs clickable', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo, { ELECTRON_RENDERER_URL: '' })
  const { app, page } = await session.launch()
  try {
    await waitForSessionReady(page)
    await page.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
    const worktreeId = await attachRepoAndOpenTerminal(page, testRepoPath)
    await page.locator('[data-workspace-multiplexer-trigger]').click()
    await page
      .locator('[data-workspace-multiplexer-page] > header')
      .getByRole('button', { name: 'Add workspace', exact: true })
      .click()
    await page
      .locator(`[data-workspace-multiplexer-worktree-id=${JSON.stringify(worktreeId)}]`)
      .click()
    const tile = page.locator('[data-workspace-multiplexer-pane-id]').first()
    await expect(tile.locator('.terminal-tab-strip [data-tab-id]')).toHaveCount(1)
    await page.evaluate(async () => {
      const state = window.__store!.getState()
      const groupId = state.workspaceMultiplexer.slots[0]!.groupId!
      await state.openNewTerminalTabInActiveWorkspace(groupId)
    })
    await tile.evaluate((element) => {
      element.style.maxWidth = '460px'
    })
    const tabs = tile.locator('.terminal-tab-strip [data-tab-id]')
    await expect(tabs).toHaveCount(2)
    const workspace = tile.locator('[data-workspace-multiplexer-tab-id]').first()
    const workspaceBox = (await workspace.boundingBox())!
    const terminalBox = (await tabs.first().boundingBox())!
    expect(terminalBox.y).toBeGreaterThanOrEqual(workspaceBox.y + workspaceBox.height)
    for (const tab of await tabs.all()) {
      await tab.click()
      await expect(tab).toHaveAttribute('data-active', 'true')
    }
    await expect(tile.getByRole('button', { name: 'Scroll tabs left' })).toHaveCount(0)
    await expect(tile.getByRole('button', { name: 'Scroll tabs right' })).toHaveCount(0)
    await expect(tile.getByRole('button', { name: 'Maximize workspace', exact: true })).toHaveCount(
      0
    )
    await tile.getByRole('button', { name: 'Workspace actions', exact: true }).click()
    await expect(
      page.getByRole('menuitem', { name: 'Split workspace right', exact: true })
    ).toBeVisible()
    await page.getByRole('menuitem', { name: 'Maximize workspace', exact: true }).click()
    await tile.getByRole('button', { name: 'Workspace actions', exact: true }).click()
    await page
      .getByRole('menuitem', { name: 'Restore Workspace Multiplexer layout', exact: true })
      .click()
    await tile.getByRole('button', { name: 'Terminal list', exact: true }).click()
    await page.getByRole('menuitemradio').first().click()
    await expect(tabs.first()).toHaveAttribute('data-active', 'true')
    await tile.getByRole('button', { name: 'Terminal list', exact: true }).click()
    await page.getByRole('menuitemradio').last().click()
    await expect(tabs.last()).toHaveAttribute('data-active', 'true')
    await tile.evaluate((element) => {
      element.style.maxWidth = '460px'
    })
    const strip = tile.locator('[data-tab-group-strip-id]')
    await strip.screenshot({ path: 'output/playwright/multiplexer-narrow-tabs.png' })
    await page.evaluate(() => window.__store!.getState().updateSettings({ theme: 'dark' }))
    await expect(page.locator('html')).toHaveClass(/dark/)
    await strip.screenshot({ path: 'output/playwright/multiplexer-narrow-tabs-dark.png' })
    await page.evaluate(async () => {
      const state = window.__store!.getState()
      const groupId = state.workspaceMultiplexer.slots[0]!.groupId!
      for (let index = 0; index < 4; index++) {
        await window.__store!.getState().openNewTerminalTabInActiveWorkspace(groupId)
      }
    })
    await expect(tabs).toHaveCount(6)
    await expect
      .poll(() =>
        tile
          .locator('.terminal-tab-strip')
          .evaluate((element) => element.scrollWidth > element.clientWidth)
      )
      .toBe(true)
    await expect(tile.getByRole('button', { name: /Scroll tabs (left|right)/ })).toHaveCount(0)
    await tile.getByRole('button', { name: 'Terminal list', exact: true }).click()
    await expect(page.getByRole('menuitemradio')).toHaveCount(6)
    await page.getByRole('menuitemradio').first().click()
    await expect(tabs.first()).toHaveAttribute('data-active', 'true')
    await tile.evaluate((element) => {
      element.style.maxWidth = ''
    })
    await expect
      .poll(async () => {
        const a = (await workspace.boundingBox())!
        const b = (await tabs.first().boundingBox())!
        return Math.abs(a.y - b.y)
      })
      .toBeLessThanOrEqual(1)
  } finally {
    await session.close(app)
    await session.dispose()
  }
})
