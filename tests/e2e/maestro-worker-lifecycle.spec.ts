import { test, expect } from './helpers/orca-app'
import { launchNativeMaestroFixture } from './helpers/maestro-fixture'

test.describe('Maestro worker lifecycle fixture', () => {
  test('releases tracked workers without releasing the loose user terminal', async () => {
    const native = await launchNativeMaestroFixture()
    try {
      const page = native.page
      await page.getByRole('button', { name: 'Release tracked workers' }).click()
      await expect(page.getByText('Cleanup settled · partial 86%', { exact: true })).toBeVisible()
      await expect(page.locator('[data-maestro-node="worker-released"]')).toHaveAttribute(
        'aria-label',
        /ORC-11 · worker · Codex, Released/
      )
      await expect(page.getByText('Connected and writable, not cleanup authority')).toBeVisible()
      await expect(page.getByText(/Offscreen is retained/)).toBeVisible()
    } finally {
      await native.close()
    }
  })
})
