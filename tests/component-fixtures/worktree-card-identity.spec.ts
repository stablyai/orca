import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/fixtures.html?id=sidebar/WorktreeCardIdentity:primarySparse&theme=light')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
})

test('restores details when the pointer leaves a clicked identity icon', async ({ page }) => {
  const card = page.locator('[data-worktree-card-surface]')
  const title = card.getByText('Primary workspace', { exact: true })
  const primary = card.getByRole('img', { name: 'Primary worktree' })

  await primary.click()
  await expect(primary).toBeFocused()
  await title.hover()
  await expect(page.locator('[data-slot="hover-card-content"]')).toBeVisible()
})

test('keeps details closed while an identity icon has keyboard focus', async ({ page }) => {
  const card = page.locator('[data-worktree-card-surface]')
  const title = card.getByText('Primary workspace', { exact: true })
  const primary = card.getByRole('img', { name: 'Primary worktree' })
  const sparse = card.getByRole('img', { name: 'Sparse checkout' })
  const details = page.locator('[data-slot="hover-card-content"]')

  await title.hover()
  await expect(details).toBeVisible()
  await title.focus()
  await page.keyboard.press('Tab')
  await expect(primary).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sparse).toBeFocused()
  await expect(page.getByRole('tooltip', { name: /Sparse checkout/ })).toBeVisible()
  await expect(details).toBeHidden()
})
