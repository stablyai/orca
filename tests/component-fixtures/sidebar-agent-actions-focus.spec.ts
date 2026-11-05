import { expect, test } from '@playwright/test'

test('returns keyboard focus to the agent menu except when opening Rename', async ({ page }) => {
  await page.goto('/fixtures.html?id=sidebar/workspace-card/activity/SidebarAgentActions:closed')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const trigger = page.getByRole('button', { name: 'Agent actions', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused()
})
