import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const MAX_TRIGGER_CHROME_WIDTH = 16
const VIEWPORTS = [
  { name: 'desktop', size: { width: 1440, height: 900 } },
  { name: 'mobile', size: { width: 390, height: 844 } }
] as const

async function assertPetTriggerFitsLabel(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Pet menu' })
  const label = trigger.locator('span')

  await expect(trigger).toBeVisible()
  await expect(label).toBeVisible()
  await expect
    .poll(async () => {
      const [triggerBox, labelBox] = await Promise.all([trigger.boundingBox(), label.boundingBox()])
      if (!triggerBox || !labelBox) {
        return Number.POSITIVE_INFINITY
      }
      return triggerBox.width - labelBox.width
    })
    .toBeLessThanOrEqual(MAX_TRIGGER_CHROME_WIDTH)
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
    await waitForActiveWorktree(orcaPage)
    await orcaPage.evaluate(async () => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('window.__store is not available')
      }
      await state.updateSettings({ experimentalPet: true })
    })

    for (const { name, size } of VIEWPORTS) {
      await orcaPage.setViewportSize(size)
      await assertPetTriggerFitsLabel(orcaPage)
      await attachTriggerScreenshot(orcaPage, testInfo, name)
    }
  })
})
