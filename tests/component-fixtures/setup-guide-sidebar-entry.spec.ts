import { expect, test } from '@playwright/test'

test('hides the onboarding checklist from the sidebar', async ({ page }) => {
  await page.goto('/fixtures.html?id=sidebar/SetupGuideSidebarEntry:idle&theme=light')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')

  const checklist = page.getByRole('button', { name: /Onboarding checklist/ })
  await expect(checklist).toBeVisible()
  await page.getByRole('button', { name: 'Hide from sidebar' }).click()
  await expect(checklist).toBeHidden()
})
