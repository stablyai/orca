import { expect, test, type Page } from '@playwright/test'

async function open(page: Page, fixture: string): Promise<void> {
  await page.goto(
    `/fixtures.html?id=native-chat/messages/events/NativeChatEventRow:${fixture}&theme=light`
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 30_000
  })
}

/** Each activity row's drawn height, with its words. */
async function rowHeights(page: Page): Promise<{ text: string; height: number }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.group\\/event-row')].map((row) => ({
      text: row.innerText.replace(/\s+/g, ' ').trim(),
      height: Math.round(row.getBoundingClientRect().height)
    }))
  )
}

for (const fixture of ['activityRows', 'activityRowsNarrow']) {
  test(`activity rows stay on one line (${fixture})`, async ({ page }) => {
    await open(page, fixture)

    const rows = await rowHeights(page)

    expect(rows.map((row) => /Created|Added|Started|Linked/.exec(row.text)?.[0])).toEqual([
      'Created',
      'Added',
      'Started',
      'Started',
      'Linked'
    ])
    for (const row of rows) {
      expect(row.height, row.text).toBeLessThanOrEqual(24)
    }
  })
}
