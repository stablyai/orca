import { expect, test } from '@playwright/test'

for (const method of ['Close', 'Escape', 'Discard']) {
  test(`returns focus to the owning composer after ${method}`, async ({ page }) => {
    await page.goto('/fixtures.html?id=native-chat/NativeChatImageCommentsDialog:focusRestoration')
    await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
    const draft = page.getByRole('textbox', { name: 'Chat draft', exact: true })
    await draft.focus()
    await page.getByRole('button', { name: 'Comment image', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Image comments', exact: true })
    await expect(dialog).toBeVisible()
    if (method === 'Discard') {
      await page.getByRole('button', { name: 'Add comment', exact: true }).click()
      await page.getByRole('textbox', { name: 'Comment 1', exact: true }).fill('Review this')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Discard', exact: true }).click()
    } else if (method === 'Escape') {
      await page.keyboard.press('Escape')
    } else {
      await page.getByRole('button', { name: 'Close', exact: true }).click()
    }
    await expect(dialog).toHaveCount(0)
    await expect(draft).toBeFocused()
  })
}
