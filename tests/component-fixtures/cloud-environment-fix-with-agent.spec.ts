import { expect, test, type Page } from '@playwright/test'

// A failed environment build offers Try again, plus Fix with agent when the install script
// failed, to admins on the latest build only.

async function open(page: Page, id: string): Promise<void> {
  await page.goto(`/fixtures.html?id=cloud-environment/CloudEnvironment:${id}&theme=light`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
}

test('an admin on a build that failed at the install script gets Try again and Fix with agent', async ({
  page
}) => {
  await open(page, 'panelOverviewFailed')
  await expect(
    page.getByText('Build #7 failed at Run install script.', { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fix with agent' })).toBeVisible()
  // Two actions: the failed step already opens on its error, and the title jumps back to it.
  await expect(page.getByRole('button', { name: 'Show error' })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Build #7 failed at Run install script.' })
  ).toBeVisible()
})

test('a clone broken by repo contents goes to an agent; a refused clone goes to GitHub', async ({
  page
}) => {
  await open(page, 'panelCloneFailedContent')
  await expect(page.getByRole('button', { name: 'Fix with agent' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Give access' })).toHaveCount(0)
  await open(page, 'panelCloneFailedAccess')
  await expect(page.getByRole('button', { name: 'Give access' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fix with agent' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
})

test('a member gets neither, and the log viewer alone adds no actions', async ({ page }) => {
  await open(page, 'panelMember')
  await expect(page.getByRole('button', { name: 'Fix with agent' })).toHaveCount(0)
  await open(page, 'logFailed')
  await expect(page.getByText(/failed at Run install script\.$/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Fix with agent' })).toHaveCount(0)
})
