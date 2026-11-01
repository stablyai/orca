import { expect, test, type Locator, type Page } from '@playwright/test'

async function center(item: Locator) {
  const bounds = await item.boundingBox()
  if (!bounds) {
    throw new Error('Menu item has no bounds')
  }
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

async function expectFocusedAtPointer(page: Page, point: { x: number; y: number }) {
  await expect
    .poll(() =>
      page.evaluate(({ x, y }) => {
        const row = document.elementFromPoint(x, y)?.closest('[role="menuitem"]')
        return Boolean(
          row && row === document.activeElement && row.hasAttribute('data-highlighted')
        )
      }, point)
    )
    .toBe(true)
}

for (const kind of ['dropdown', 'context'] as const) {
  test.describe(kind, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/fixtures.html?id=ui/menu-pointer-highlight:${kind}`)
      await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
      await page.getByText('Open menu', { exact: true }).click({
        button: kind === 'context' ? 'right' : 'left'
      })
      await expect(page.getByRole('menuitem', { name: 'Row 1', exact: true })).toBeVisible()
    })

    test('wheel scrolling keeps focus under a stationary cursor', async ({ page }) => {
      const row = page.getByRole('menuitem', { name: 'Row 3', exact: true })
      const point = await center(row)
      await page.mouse.move(point.x, point.y)
      await expect(row).toBeFocused()
      const menu = page.locator(`[data-slot="${kind}-menu-content"]`)
      // Sample the scroll frame before deferred hover events can hide a stale highlight.
      await menu.evaluate((element, pointer) => {
        element.addEventListener('scroll', () => {
          requestAnimationFrame(() => {
            const hit = document
              .elementFromPoint(pointer.x, pointer.y)
              ?.closest('[role="menuitem"]')
            element.setAttribute(
              'data-scroll-frame-focused',
              String(hit === document.activeElement)
            )
            element.setAttribute('data-scroll-frame-top', String(element.scrollTop))
          })
        })
      }, point)
      let previousScroll = 0
      for (const delta of [72, 96, 120]) {
        await page.mouse.wheel(0, delta)
        await expect
          .poll(() => menu.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(previousScroll)
        await expect
          .poll(() => menu.getAttribute('data-scroll-frame-top').then(Number))
          .toBeGreaterThan(previousScroll)
        await expect(menu).toHaveAttribute('data-scroll-frame-focused', 'true')
        await expectFocusedAtPointer(page, point)
        await expect(row).not.toBeFocused()
        previousScroll = await menu.evaluate((element) => element.scrollTop)
      }
    })

    test('resting over the next submenu completes the pointer handoff', async ({ page }) => {
      const first = page.getByRole('menuitem', { name: 'First', exact: true })
      const second = page.getByRole('menuitem', { name: 'Second', exact: true })
      const start = await center(first)
      const destination = await center(second)
      await page.mouse.move(start.x, start.y)
      await expect(page.getByRole('menuitem', { name: 'First child', exact: true })).toBeVisible()
      // Move toward the submenu while crossing onto its sibling, then stop inside the safe triangle.
      await page.mouse.move(start.x + 5, start.y)
      await page.mouse.move(destination.x + 35, destination.y)
      await expect(second).toBeFocused()
      await expect(second).toHaveAttribute('data-state', 'open')
      await expect(first).toHaveAttribute('data-state', 'closed')
      await expect(page.getByRole('menuitem', { name: 'Second child', exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'First child', exact: true })).toBeHidden()
    })
  })
}
