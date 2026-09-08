import { expect, type Page } from '@stablyai/playwright-test'

export async function openSidebarProjectDialog(page: Page): Promise<void> {
  // The compact overflow retains standalone project import; the composer hosts a different flow.
  await page.evaluate(() => window.__store!.getState().setSidebarWidth(220))
  await page.getByRole('button', { name: 'More workspace actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add Project', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /Add a project/i })).toBeVisible()
}
