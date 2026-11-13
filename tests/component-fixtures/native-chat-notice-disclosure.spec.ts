import { expect, test } from '@playwright/test'

test('Enter and Space keep the retry summary and disclosure choice in sync', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto(
    '/fixtures.html?id=native-chat/messages/notices/NativeChatNoticeRow:storedRetryNotice&theme=light'
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 90_000
  })
  const summary = page.locator('summary')
  const choice = page.locator('[data-disclosure-choice]')
  await summary.focus()
  await expect(summary).toBeFocused()
  await expect(summary).toHaveAttribute('aria-expanded', 'false')
  await expect(choice).toHaveAttribute('data-disclosure-choice', 'undefined')
  await summary.press('Enter')
  await expect(summary).toHaveAttribute('aria-expanded', 'true')
  await expect(choice).toHaveAttribute('data-disclosure-choice', 'true')
  await summary.press('Space')
  await expect(summary).toHaveAttribute('aria-expanded', 'false')
  await expect(choice).toHaveAttribute('data-disclosure-choice', 'false')
})
