import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// A 1x1 PNG, standing in for what app.getFileIcon() returns for a picked app.
const PICKED_APP_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test.describe('Open In Apps icon picker', () => {
  test('sets and clears a bundled icon on an Open in app row', async ({ orcaPage }, testInfo) => {
    await waitForSessionReady(orcaPage)

    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Why: the spec asserts on English strings; the host machine may run a
      // non-English system locale, which 'system' would follow.
      await store.getState().updateSettings({
        uiLanguage: 'en',
        openInApplications: [{ id: 'idea', label: 'IntelliJ IDEA', command: 'idea' }]
      })
      // Why: navigate straight to the section. Typing in the settings search
      // debounces a re-filter that remounts rows, which would drop the popover's
      // open state out from under the click below.
      store.getState().openSettingsTarget({
        pane: 'general',
        repoId: null,
        sectionId: 'general-open-in-apps'
      })
      store.getState().openSettingsPage()
    })

    await expect(orcaPage.getByText('IntelliJ IDEA', { exact: true })).toBeVisible()

    await orcaPage.getByRole('button', { name: 'Change app icon' }).first().click()
    await expect(orcaPage.getByRole('button', { name: 'Use Braces icon' })).toBeVisible()
    // The OS file dialog can't be driven from here, so this only asserts the entry point.
    await expect(
      orcaPage.getByRole('button', { name: "Use an installed app's icon…" })
    ).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('icon-grid.png') })

    await orcaPage.getByRole('button', { name: 'Use Braces icon' }).click()
    await expect(orcaPage.getByRole('button', { name: 'Use Braces icon' })).not.toBeVisible()

    const stored = async (): Promise<unknown> =>
      orcaPage.evaluate(() => window.__store?.getState().settings?.openInApplications)
    expect(await stored()).toEqual([
      {
        id: 'idea',
        label: 'IntelliJ IDEA',
        command: 'idea',
        icon: { type: 'bundled', id: 'Braces' }
      }
    ])
    await orcaPage.screenshot({ path: testInfo.outputPath('icon-applied.png') })

    await orcaPage.getByRole('button', { name: 'Change app icon' }).first().click()
    await orcaPage.getByRole('button', { name: 'Use default icon' }).click()
    expect(await stored()).toEqual([{ id: 'idea', label: 'IntelliJ IDEA', command: 'idea' }])
  })

  // Why: `getFileIcon` aborts the main process for some size options, which no
  // try/catch can see — only driving the real handler against a real app catches it.
  test('extracts a real installed app icon without taking the app down', async ({
    electronApp,
    orcaPage
  }) => {
    test.skip(process.platform !== 'darwin', 'Uses a macOS system app bundle.')
    await waitForSessionReady(orcaPage)

    await electronApp.evaluate(({ dialog }, appPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [appPath] })
    }, '/System/Applications/Utilities/Terminal.app')

    const picked = await orcaPage.evaluate(() => window.api.shell.pickOpenInAppIcon())

    expect(picked?.label).toBe('Terminal')
    expect(picked?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    // The app is still alive, and the icon is small enough to sync in settings.
    expect(await electronApp.evaluate(({ app }) => app.isReady())).toBe(true)
    expect(picked!.dataUrl.length).toBeLessThan(64 * 1024)

    // Why: the type-based icon API returns one generic badge for every .app bundle,
    // which looks like a working feature until you compare two apps.
    await electronApp.evaluate(({ dialog }, appPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [appPath] })
    }, '/System/Applications/Calculator.app')
    const other = await orcaPage.evaluate(() => window.api.shell.pickOpenInAppIcon())

    expect(other?.label).toBe('Calculator')
    expect(other?.dataUrl).not.toBe(picked?.dataUrl)
  })

  test('renders an icon extracted from an installed app', async ({ orcaPage }, testInfo) => {
    await waitForSessionReady(orcaPage)

    await orcaPage.evaluate(async (src) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().updateSettings({
        uiLanguage: 'en',
        openInApplications: [
          {
            id: 'idea',
            label: 'IntelliJ IDEA',
            command: 'idea',
            icon: { type: 'image', src }
          }
        ]
      })
      store.getState().openSettingsTarget({
        pane: 'general',
        repoId: null,
        sectionId: 'general-open-in-apps'
      })
      store.getState().openSettingsPage()
    }, PICKED_APP_ICON)

    await expect(orcaPage.getByText('IntelliJ IDEA', { exact: true })).toBeVisible()

    const trigger = orcaPage.getByRole('button', { name: 'Change app icon' }).first()
    await expect(trigger.locator('img')).toHaveAttribute('src', PICKED_APP_ICON)
    await orcaPage.screenshot({ path: testInfo.outputPath('picked-app-icon.png') })
  })
})
