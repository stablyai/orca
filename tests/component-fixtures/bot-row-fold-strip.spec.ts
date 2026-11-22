import { expect, test, type Page } from '@playwright/test'

// The first fixture page load also compiles the explorer.
test.describe.configure({ timeout: 120_000 })

// The narrow case holds folded rows with and without a status, a long name and unfolded rows.
const frame = '[data-case^="Narrow sidebar"]'
const rows = `${frame} .group\\/bot-row`

const open = async (page: Page): Promise<void> => {
  await page.goto('/fixtures.html?id=bots/BotRow:botRowCases&theme=light')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 60_000
  })
  // The Up next counts arrive after first paint.
  await expect(page.locator(`${frame} button[aria-label*="suggestion"]`)).toHaveCount(4)
}

const resize = async (page: Page, width: number): Promise<void> => {
  await page.locator(frame).evaluate((element, w) => {
    element.setAttribute('style', `width: ${w}px`)
  }, width)
  await page.mouse.move(990, 700)
}

// Every box in the frame to 0.1px, relative to it, so any moved avatar, title, time, line, count or
// strip shows up however the page scrolls; glyph paths only add sub-pixel noise.
const layout = (page: Page): Promise<string[]> =>
  page.locator(frame).evaluate((element) => {
    const origin = element.getBoundingClientRect()
    const px = (value: number): number => Math.round(value * 10) / 10
    return [...element.querySelectorAll('*:not(svg *)')].map((node) => {
      const box = node.getBoundingClientRect()
      return `${node.tagName} ${px(box.x - origin.x)},${px(box.y - origin.y)} ${px(box.width)}x${px(box.height)}`
    })
  })

for (const width of [196, 220, 240, 260, 280, 360]) {
  test(`hovering or tabbing through bot rows at ${width}px never moves them`, async ({ page }) => {
    await open(page)
    await resize(page, width)
    const rest = await layout(page)

    const count = await page.locator(rows).count()
    for (let index = 0; index < count; index++) {
      await page
        .locator(rows)
        .nth(index)
        .hover({ position: { x: 20, y: 20 } })
      expect(await layout(page), `hovering row ${index}`).toEqual(rest)
    }

    await page.mouse.move(990, 700)
    const folds = page.locator(`${frame} button[aria-expanded]`)
    for (let index = 0; index < (await folds.count()); index++) {
      // Tab onto each strip from what precedes it, so it takes keyboard focus and its ring.
      await folds.nth(index).focus()
      await page.keyboard.press('Shift+Tab')
      expect(await layout(page), `before strip ${index}`).toEqual(rest)
      await page.keyboard.press('Tab')
      await expect(folds.nth(index)).toBeFocused()
      expect(await folds.nth(index).evaluate((node) => node.matches(':focus-visible'))).toBe(true)
      expect(await layout(page), `focusing strip ${index}`).toEqual(rest)
    }
  })
}

test('a narrow row keeps a 24px strip that fits its status', async ({ page }) => {
  await open(page)
  await resize(page, 196)
  const folds = page.locator(`${frame} button[aria-expanded]`)
  for (let index = 0; index < (await folds.count()); index++) {
    const strip = await folds.nth(index).boundingBox()
    expect(strip!.width).toBeGreaterThanOrEqual(24)
    for (const glyph of await folds.nth(index).locator(':scope > span').all()) {
      const box = await glyph.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(strip!.x)
      expect(box!.x + box!.width).toBeLessThanOrEqual(strip!.x + strip!.width)
    }
  }
})
