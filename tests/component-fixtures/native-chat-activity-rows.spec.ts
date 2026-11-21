import { expect, test, type Page } from '@playwright/test'

async function open(page: Page, fixture: string): Promise<void> {
  const id = fixture.includes(':')
    ? fixture
    : `native-chat/messages/events/NativeChatEventRow:${fixture}`
  await page.goto(`/fixtures.html?id=${id}&theme=light`)
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

/** Each row's pieces as drawn: none may shrink away, as a bare name once did. */
async function narrowestPiece(page: Page): Promise<{ text: string; width: number }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.group\\/event-row')].map((row) => {
      const words = row.querySelector<HTMLElement>(':scope > .overflow-x-clip')!
      const widths = [...words.children]
        .filter((piece) => !piece.classList.contains('sr-only'))
        .map((piece) => piece.getBoundingClientRect().width)
      return { text: row.innerText.trim(), width: Math.round(Math.min(...widths)) }
    })
  )
}

for (const fixture of [
  'native-chat/NativeChatBotRequestCard:requestsNarrow',
  'native-chat/NativeChatToolAddedCard:addedNarrow'
]) {
  test(`rows with plain words keep every piece on one line (${fixture})`, async ({ page }) => {
    await open(page, fixture)

    const rows = await rowHeights(page)
    const pieces = await narrowestPiece(page)

    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row.height, row.text).toBeLessThanOrEqual(24)
    }
    for (const piece of pieces) {
      expect(piece.width, piece.text).toBeGreaterThanOrEqual(24)
    }
  })
}
