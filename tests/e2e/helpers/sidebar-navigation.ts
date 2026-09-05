import { expect, type Page } from '@stablyai/playwright-test'

/** Open Add Project through the current sidebar/composer entry point. */
export async function openAddProjectDialog(page: Page): Promise<void> {
  const legacyButton = page.getByRole('button', { name: /Add Project/i }).first()
  if (await legacyButton.isVisible().catch(() => false)) {
    await legacyButton.click()
  } else {
    await page
      .getByRole('button', { name: /New workspace/i })
      .first()
      .click()
    await page.getByRole('button', { name: 'Add project', exact: true }).click()
  }
  await expect(page.getByRole('dialog', { name: /Add a project/i })).toBeVisible()
}
