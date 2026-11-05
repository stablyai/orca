import { expect, test } from '@playwright/test'

test('hides the onboarding checklist from the sidebar', async ({ page }) => {
  await page.goto('/fixtures.html?id=sidebar/SetupGuideSidebarEntry:idle&theme=light')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')

  const checklist = page.getByRole('button', { name: /Onboarding checklist/ })
  await expect(checklist).toBeVisible()
  await page.getByRole('button', { name: 'Hide from sidebar' }).click()
  await expect(checklist).toBeHidden()
})

test('moves keyboard focus to the next sidebar control after hiding', async ({ page }) => {
  await page.goto('/fixtures.html?id=sidebar/SetupGuideSidebarEntry:navigation&theme=light')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')

  await page.getByRole('button', { name: 'Hide from sidebar' }).focus()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: /Onboarding checklist/ })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeFocused()
})

test('returns keyboard focus to the previous control when no next control exists', async ({
  page
}) => {
  await page.goto(
    '/fixtures.html?id=sidebar/SetupGuideSidebarEntry:lastNavigationEntry&theme=light'
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')

  await page.getByRole('button', { name: 'Hide from sidebar' }).focus()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: /Onboarding checklist/ })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused()
})
