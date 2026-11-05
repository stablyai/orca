import { expect, test } from '@playwright/test'

test('keyboard pin movement persists percentage coordinates in exported comments', async ({
  page
}) => {
  await page.goto('/fixtures.html?id=native-chat/NativeChatImageCommentsDialog:preview')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  await page.getByRole('button', { name: 'Add comment', exact: true }).click()
  await page.getByRole('textbox', { name: 'Comment 1', exact: true }).fill('Align this')
  const pin = page.locator('[data-image-comment-id]').first()
  await pin.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowUp')
  await expect(page.getByText('x 51.00% · y 45.00%', { exact: true })).toBeVisible()
  await expect(pin).toBeFocused()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect
    .poll(() => page.locator('html').getAttribute('data-image-comment-result'))
    .toContain('[x=51.00%, y=45.00%] Align this')
})
