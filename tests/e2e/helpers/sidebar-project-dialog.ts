import { expect, type Page } from '@stablyai/playwright-test'

export async function openSidebarProjectDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /Add a project/i })).toBeVisible()
}

export async function openSidebarWorkspaceComposer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const newWorkspaceItem = page.getByRole('menuitem', { name: /^New workspace/ })
  await expect(newWorkspaceItem).toBeVisible()
  await newWorkspaceItem.click()
}
