import { expect, type Page } from '@stablyai/playwright-test'

// Scope to the sidebar because Landing renders another Add project button when no workspace is open.
function sidebarHeaderActions(page: Page) {
  return page.locator('[data-sidebar-header-actions]')
}

export async function openSidebarProjectDialog(page: Page): Promise<void> {
  await sidebarHeaderActions(page).getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /Add a project/i })).toBeVisible()
}

export async function showWorkspaceSidebar(page: Page): Promise<void> {
  const title = page.locator('[data-sidebar-section-title]').first()
  if ((await title.getAttribute('data-sidebar-section-title')) !== 'workspaces') {
    await title.click()
    await page.getByRole('menuitem', { name: 'Workspaces', exact: true }).click()
  }
}

export async function openSidebarWorkspaceComposer(page: Page): Promise<void> {
  await showWorkspaceSidebar(page)
  const createButton = sidebarHeaderActions(page).getByRole('button', {
    name: 'New workspace',
    exact: true
  })
  await expect(createButton).toBeVisible()
  await createButton.click()
}
