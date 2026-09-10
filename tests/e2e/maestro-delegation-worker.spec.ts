import { test, expect } from './helpers/orca-app'
import { launchNativeMaestroFixture } from './helpers/maestro-fixture'

test.describe('Maestro delegation worker fixture', () => {
  test('observes adaptive reduction and evidence-backed parallel expansion', async () => {
    const native = await launchNativeMaestroFixture()
    try {
      const page = native.page
      await page.getByRole('button', { name: 'Reduce' }).click()
      await expect(page.locator('[data-orc11-reduction]')).toHaveText(
        'single_writer · receipt resource-pressure-receipt-01'
      )
      await page.getByRole('button', { name: 'Expand' }).click()
      await expect(page.locator('[data-orc11-reduction]')).toHaveText(
        'parallel · receipt evidence-backed-parallel-receipt-02'
      )
      await expect(page.locator('[data-maestro-node="worker"]')).toHaveAttribute(
        'aria-label',
        /ORC-11.*Running/
      )
    } finally {
      await native.close()
    }
  })
})
