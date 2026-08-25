import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Why: post-fix trailing overhang is ~0px; 16px is subpixel headroom that still
// fails the old pr-[6.5rem] (~104px) reservation.
const MAX_TRAILING_CHROME_PX = 16
const VIEWPORTS = [
  { name: 'desktop', size: { width: 1440, height: 900 } },
  { name: 'mobile', size: { width: 390, height: 844 } }
] as const

async function enableExperimentalPet(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: updateSettings swallows errors; throw so a failed persist fails loudly.
    await store.getState().updateSettingsOrThrow({ experimentalPet: true })
  })
  await expect
    .poll(
      async () =>
        page.evaluate(() => window.__store?.getState().settings?.experimentalPet === true),
      { message: 'experimentalPet did not become true after updateSettingsOrThrow' }
    )
    .toBe(true)
}

async function assertPetTriggerFitsLabel(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Pet menu' })
  // Why: only the label span is a direct child; avoid matching nested menu spans
  // if the open state ever leaks into the measurement.
  const label = trigger.locator(':scope > span')

  await expect(trigger).toBeVisible()
  await expect(label).toBeVisible()
  // Why: measure trailing overhang (trigger right − label right), not total width
  // delta — the regression is empty space *after* the label (the old pr-[6.5rem]).
  await expect
    .poll(
      async () => {
        const [triggerBox, labelBox] = await Promise.all([
          trigger.boundingBox(),
          label.boundingBox()
        ])
        if (!triggerBox || !labelBox) {
          return Number.POSITIVE_INFINITY
        }
        return triggerBox.x + triggerBox.width - (labelBox.x + labelBox.width)
      },
      { message: 'pet menu trigger still reserves trailing space after its label' }
    )
    .toBeLessThanOrEqual(MAX_TRAILING_CHROME_PX)
}

async function attachTriggerScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Pet menu' })
  const screenshotPath = testInfo.outputPath(`pet-status-trigger-${name}.png`)
  await trigger.screenshot({ path: screenshotPath })
  await testInfo.attach(`pet-status-trigger-${name}`, {
    path: screenshotPath,
    contentType: 'image/png'
  })
}

test.describe('Pet status segment layout', () => {
  test('does not reserve empty space after its label', async ({ orcaPage }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await enableExperimentalPet(orcaPage)

    for (const { name, size } of VIEWPORTS) {
      await orcaPage.setViewportSize(size)
      await assertPetTriggerFitsLabel(orcaPage)
      await attachTriggerScreenshot(orcaPage, testInfo, name)
    }
  })
})
