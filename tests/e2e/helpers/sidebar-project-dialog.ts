import { expect, type Page } from '@stablyai/playwright-test'

// Why scoped: the Landing screen renders its own "Add project" button whenever no
// workspace is open, which is exactly the state these helpers run in.
function sidebarHeaderActions(page: Page) {
  return page.locator('[data-sidebar-header-actions]')
}

export async function openSidebarProjectDialog(page: Page): Promise<void> {
  await sidebarHeaderActions(page).getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /Add a project/i })).toBeVisible()
}

export async function openSidebarWorkspaceComposer(page: Page): Promise<void> {
  const createButton = sidebarHeaderActions(page).getByRole('button', {
    name: 'New workspace',
    exact: true
  })
  await expect(createButton).toBeVisible()
  await createButton.click()
}
