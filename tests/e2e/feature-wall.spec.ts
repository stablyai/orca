import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

async function openFeatureTourFromMenu(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, Menu }) => {
    const featureTourItem = Menu.getApplicationMenu()
      ?.items.find((item) => item.label === 'Help')
      ?.submenu?.items.find((item) => item.label === 'Feature tour')

    if (!featureTourItem) {
      throw new Error('Feature tour menu item was not registered')
    }

    const window = BrowserWindow.getAllWindows()[0]
    featureTourItem.click(featureTourItem, window, {
      triggeredByAccelerator: false,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false
    } as Electron.KeyboardEvent)
  })
}

async function loadedFeatureWallImageCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-feature-wall-tile-id] img')).filter(
      (image): image is HTMLImageElement =>
        image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
    ).length
  })
}

test.describe('Feature tour modal', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('opens from the Help menu, renders bundled media, and closes cleanly', async ({
    electronApp,
    orcaPage
  }) => {
    await openFeatureTourFromMenu(electronApp)

    await expect(orcaPage.getByRole('dialog', { name: 'Feature tour' })).toBeVisible({
      timeout: 10_000
    })
    await expect(orcaPage.getByText('A quick look at the Orca features')).toBeVisible()
    await expect(orcaPage.getByRole('listitem')).toHaveCount(12)
    await expect(
      orcaPage.getByRole('listitem', { name: /Remote worktrees over SSH/i })
    ).toBeVisible()

    await expect
      .poll(async () => loadedFeatureWallImageCount(orcaPage), {
        timeout: 10_000,
        message: 'feature-wall media did not load'
      })
      .toBeGreaterThanOrEqual(11)

    const assetSources = await orcaPage
      .locator('[data-feature-wall-tile-id] img')
      .evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src))
    expect(assetSources.length).toBeGreaterThanOrEqual(11)
    expect(assetSources.every((src) => src.includes('/onboarding/feature-wall/'))).toBe(true)

    await orcaPage.locator('[data-feature-wall-tile-id="tile-01"]').focus()
    await orcaPage.keyboard.press('ArrowRight')
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset.featureWallTileId
        )
      )
      .toBe('tile-02')

    await orcaPage.getByRole('button', { name: 'Close' }).click()
    await expect(orcaPage.getByRole('dialog', { name: 'Feature tour' })).toHaveCount(0)
    await expect.poll(async () => getStoreState<string>(orcaPage, 'activeModal')).toBe('none')
  })
})
