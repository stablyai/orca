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

/** Two full rows at `columns`: a lone partial first row shows, a partial later row hides. */
function expectedRows(count: number, columns: number): number[] {
  if (count <= columns) {
    return [count]
  }
  return Array.from({ length: Math.min(2, Math.floor(count / columns)) }, () => columns)
}

// Why container widths: the grid's breakpoints are container queries on the catalog's content box,
// so each edge is set on that box, one pixel below and at the breakpoint.
for (const [containerWidth, columns] of [
  [459, 1],
  [460, 2],
  [719, 2],
  [720, 3],
  [1055, 3],
  [1056, 4]
] as const) {
  test(`Newly added keeps two full rows for 1-9 cards at a ${containerWidth}px catalog`, async ({
    page
  }) => {
    await openFixture(page, 'page1440', 1440)
    const catalog = page.locator('.\\@container\\/plugin-catalog')
    // Why size the catalog itself: the fixture host pins its own width, whatever the viewport.
    const contentWidth = await catalog.evaluate((node, width) => {
      const style = getComputedStyle(node)
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
      if (!(node instanceof HTMLElement)) {
        throw new Error('Catalog is not an HTML element')
      }
      node.style.boxSizing = 'border-box'
      node.style.width = `${width + padding}px`
      return node.clientWidth - padding
    }, containerWidth)
    expect(contentWidth).toBe(containerWidth)

    // Why trim from the end: the hide rules are CSS over the list, so fewer children is fewer cards.
    for (let count = 9; count >= 1; count -= 1) {
      await page.getByRole('region', { name: 'Newly added' }).evaluate((section, keep) => {
        const grid = section.querySelector('ul')
        while (grid && grid.children.length > keep) {
          grid.lastElementChild?.remove()
        }
      }, count)
      const layout = await newlyAddedRows(page)
      expect(layout.columns, `${count} cards`).toBe(columns)
      expect(layout.rows, `${count} cards`).toEqual(expectedRows(count, columns))
    }
  })
}
