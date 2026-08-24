import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.describe('Settings sidebar search on the Shortcuts pane', () => {
  test('pane-title-only query keeps rows visible and local search usable', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)

    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Why: the spec asserts on English strings; the host machine may run a
      // non-English system locale, which 'system' would follow.
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.getState().openSettingsPage()
    })

    const searchInput = orcaPage.getByPlaceholder('Search settings')
    await expect(searchInput).toBeVisible()
    // Why: plain Settings open should land focus in search so typing starts immediately.
    await expect(searchInput).toBeFocused()
    await searchInput.fill('shortcuts')

    // The query matches the pane title, so the Shortcuts pane auto-activates.
    await expect(orcaPage.getByRole('heading', { name: 'Shortcuts', exact: true })).toBeVisible()

    // Regression: a pane-title-only query used to blank the whole list (0/112).
    await expect(orcaPage.getByText('Go to File', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('No shortcuts match those filters.')).not.toBeVisible()

    // Regression: the pane's own search was dead while the global query was
    // active, because it intersected with an already-empty base list.
    const localSearch = orcaPage.getByPlaceholder('Search command or keys')
    await localSearch.fill('go to')
    await expect(orcaPage.getByText('Go to File', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Force Reload', { exact: true })).not.toBeVisible()

    // A row-matching global query still narrows the list as before.
    await localSearch.clear()
    await searchInput.fill('worktree')
    await expect(orcaPage.getByText('Create worktree', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Go to File', { exact: true })).not.toBeVisible()
  })

  test('terminal shortcut capture notifications can be found and disabled', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const rendererErrors: string[] = []
    orcaPage.on('console', (message) => {
      if (message.type() === 'error') {
        rendererErrors.push(message.text())
      }
    })
    orcaPage.on('pageerror', (error) => rendererErrors.push(error.message))

    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().updateSettings({
        uiLanguage: 'en',
        terminalShortcutCaptureNotificationEnabled: true
      })
      store.getState().openSettingsTarget({ pane: 'shortcuts', repoId: null })
      store.getState().openSettingsPage()
    })

    const searchInput = orcaPage.getByPlaceholder('Search settings')
    await searchInput.fill('toast')

    const toggle = orcaPage.getByRole('switch', {
      name: 'Show terminal shortcut capture notifications'
    })
    await expect(toggle).toBeVisible()
    await expect(toggle).toBeChecked()

    const enabledScreenshotPath = testInfo.outputPath(
      'terminal-shortcut-capture-notification-on.png'
    )
    await orcaPage.screenshot({ path: enabledScreenshotPath, animations: 'disabled' })
    await testInfo.attach('terminal shortcut capture notification enabled', {
      path: enabledScreenshotPath,
      contentType: 'image/png'
    })

    await toggle.click()

    await expect(toggle).not.toBeChecked()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () => window.__store?.getState().settings?.terminalShortcutCaptureNotificationEnabled
        )
      )
      .toBe(false)

    await searchInput.focus()
    const disabledScreenshotPath = testInfo.outputPath(
      'terminal-shortcut-capture-notification-off.png'
    )
    await orcaPage.screenshot({ path: disabledScreenshotPath, animations: 'disabled' })
    await testInfo.attach('terminal shortcut capture notification disabled', {
      path: disabledScreenshotPath,
      contentType: 'image/png'
    })
    expect(rendererErrors).toEqual([])
  })
})
