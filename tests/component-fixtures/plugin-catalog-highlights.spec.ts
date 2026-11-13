import { expect, test, type Page } from '@playwright/test'

async function openFixture(page: Page, name: string, width: number) {
  await page.setViewportSize({ width, height: 844 })
  await page.goto(`/fixtures.html?id=plugins/catalog/PluginCatalogHighlights:${name}&theme=light`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  await page.evaluate(() => document.fonts.ready)
}

/** Visible Newly added cards per row, and the grid's column count. */
async function newlyAddedRows(page: Page) {
  return page.getByRole('region', { name: 'Newly added' }).evaluate((section) => {
    const grid = section.querySelector('ul')
    if (!grid) {
      throw new Error('Newly added has no grid')
    }
    const tops = Array.from(grid.children)
      .map((card) => card.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => Math.round(rect.top))
    const rows = [...new Set(tops)].map((top) => tops.filter((other) => other === top).length)
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length
    return { rows, columns }
  })
}

for (const [name, width, rows] of [
  ['page1440', 1440, [4, 4]],
  ['page600', 600, [2, 2]],
  ['page390', 390, [1, 1]],
  ['fiveNewlyAdded1440', 1440, [4]],
  ['fiveNewlyAdded900', 900, [3]],
  ['fiveNewlyAdded600', 600, [2, 2]]
] as const) {
  test(`Newly added shows at most two full rows in ${name}`, async ({ page }) => {
    await openFixture(page, name, width)
    const layout = await newlyAddedRows(page)
    expect(layout.rows).toEqual(rows)
    expect(layout.rows.every((count) => count === layout.columns)).toBe(true)
  })
}

test('the catalogs start within two screens at phone width', async ({ page }) => {
  await openFixture(page, 'page390', 390)
  const heading = page.getByRole('heading', { name: 'Orca Official Plugins' })
  const top = await heading.evaluate((node) => node.getBoundingClientRect().top + window.scrollY)
  expect(top).toBeLessThan(2 * 844)
})

test('cards past two rows stay in their catalog group', async ({ page }) => {
  await openFixture(page, 'page390', 390)
  // Why Hilbana: third newest, so Newly added hides it at one column.
  const card = '[data-plugin-key="hilbana.hilbana"]'
  await expect(page.getByRole('region', { name: 'Newly added' }).locator(card)).toBeHidden()
  await expect(
    page.getByRole('region', { name: 'Orca Community Plugins' }).locator(card)
  ).toBeVisible()
})
