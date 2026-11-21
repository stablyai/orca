import { expect, test } from '@playwright/test'

test('keeps a scrolled-up reader on their comment when earlier activity lands above', async ({
  page
}) => {
  await page.goto('/fixtures.html?id=bots/items/BotItemView:reader&theme=light')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const comment = page.getByText('Comment 9', { exact: true })
  await expect(comment).toBeVisible()
  await comment.hover()
  await page.mouse.wheel(0, -240)
  await expect.poll(async () => (await comment.boundingBox())?.y ?? 0).toBeGreaterThan(300)
  const before = (await comment.boundingBox())?.y ?? 0

  await page.getByRole('button', { name: 'Add earlier' }).click()
  await expect(page.getByText('Earlier comment 12', { exact: true })).toBeAttached()

  await expect.poll(async () => (await comment.boundingBox())?.y).toBe(before)
})
