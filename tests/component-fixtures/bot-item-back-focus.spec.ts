import { expect, test, type Page } from '@playwright/test'

// Back from an item focuses the row it came from: quietly, so a mouse user sees no keyboard ring.
const backChord = process.platform === 'darwin' ? 'Meta+BracketLeft' : 'Alt+ArrowLeft'
const title = 'Reply chips for Slack threads'

async function openItem(page: Page): Promise<void> {
  await page.goto('/fixtures.html?id=bots/BotNeedsYouSection:proposed&theme=light')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 30_000
  })
  await page.locator('[data-bot-item-open]', { hasText: title }).click()
  await expect(page.locator('[data-bot-item-pane]')).toBeVisible()
}

async function expectQuietRow(page: Page): Promise<void> {
  const row = page.locator('[data-bot-item-open]', { hasText: title })
  await expect(row).toBeFocused()
  expect(await row.evaluate((element) => element.matches(':focus-visible'))).toBe(false)
}

const backs: Record<string, (page: Page) => Promise<void>> = {
  Escape: (page) => page.keyboard.press('Escape'),
  'the back chord': (page) => page.keyboard.press(backChord),
  'the Items button': (page) => page.getByRole('button', { name: 'Items', exact: true }).click()
}

for (const [name, back] of Object.entries(backs)) {
  test(`${name} returns focus to the row without the keyboard ring`, async ({ page }) => {
    await openItem(page)
    await back(page)
    await expectQuietRow(page)

    // Tab navigation starts from the row, and the ring is back for it.
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Done', exact: true }).first()).toBeFocused()
    expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true)
    await page.keyboard.press('Shift+Tab')
    const row = page.locator('[data-bot-item-open]', { hasText: title })
    await expect(row).toBeFocused()
    expect(await row.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
  })
}

test('Escape after a step returns quietly to the row stepped to', async ({ page }) => {
  await openItem(page)
  await expect(page.getByText('5 / 5')).toBeVisible()
  await page.getByRole('button', { name: 'Previous item' }).click()
  await expect(page.getByText('4 / 5')).toBeVisible()
  await page.keyboard.press('Escape')
  const rows = page.locator('[data-bot-item-open]')
  await expect(rows.nth(3)).toBeFocused()
  expect(await rows.nth(3).evaluate((element) => element.matches(':focus-visible'))).toBe(false)
})

test('Enter on the restored row reopens it, and Escape returns quietly again', async ({ page }) => {
  await openItem(page)
  await page.keyboard.press('Escape')
  await expectQuietRow(page)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-bot-item-pane]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expectQuietRow(page)
})
