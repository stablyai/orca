import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'

test('add offer connects a late worker without creating a default shell', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo, { ELECTRON_RENDERER_URL: '' })
  const { app, page } = await session.launch()
  try {
    await waitForSessionReady(page)
    await page.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
    await page.locator('[data-workspace-multiplexer-trigger]').click()
    const target = await attachRepoAndOpenTerminal(page, testRepoPath)
    await page.evaluate((id) => {
      const store = window.__store!
      const state = store.getState()
      const worktree = state.getKnownWorktreeById(id)!
      const createdAt = Date.now() + 1_000
      store.setState({
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [worktree.repoId]: state.worktreesByRepo[worktree.repoId].map((w) =>
            w.id === id ? { ...w, instanceId: 'offer-repro', createdAt } : w
          )
        },
        worktreeLineageById: {
          ...state.worktreeLineageById,
          [id]: { origin: 'orchestration', createdAt, worktreeInstanceId: 'offer-repro' }
        }
      })
    }, target)
    await page.getByRole('button', { name: 'Add to multiplexer', exact: true }).click()
    const tile = page.locator('[data-workspace-multiplexer-pane-id]').first()
    await expect(tile).toBeVisible()
    const tabs = tile.locator('.terminal-tab-strip [data-tab-id]')
    await expect(tabs).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }, worktreeId) => {
      BrowserWindow.getAllWindows()[0].webContents.send('ui:createTerminal', {
        worktreeId,
        title: 'Late worker fixture',
        presentation: 'visible',
        activate: false,
        focus: false
      })
    }, target)
    await expect(tabs).toHaveCount(1)
    await expect(tile.locator('[data-tab-title="Late worker fixture"]')).toHaveAttribute(
      'data-active',
      'true'
    )
    await tile.screenshot({ path: 'output/playwright/multiplexer-add-offer-fixed.png' })
  } finally {
    await session.close(app)
    await session.dispose()
  }
})
