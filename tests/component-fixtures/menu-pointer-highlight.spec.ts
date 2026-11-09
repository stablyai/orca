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

    test('wheel scrolling away from an open submenu follows the row under the cursor', async ({
      page
    }) => {
      const first = page.getByRole('menuitem', { name: 'First', exact: true })
      const point = await center(first)
      await page.mouse.move(point.x, point.y)
      await expect(page.getByRole('menuitem', { name: 'First child', exact: true })).toBeVisible()
      const menu = page.locator(`[data-slot="${kind}-menu-content"]`)
      await page.mouse.wheel(0, 96)
      await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await expectFocusedAtPointer(page, point)
      await expect(first).toHaveAttribute('data-state', 'closed')
    })

    test('keeps submenu pointer grace after wheel scrolling', async ({ page }) => {
      const first = page.getByRole('menuitem', { name: 'First', exact: true })
      const second = page.getByRole('menuitem', { name: 'Second', exact: true })
      const start = await first.boundingBox()
      if (!start) {
        throw new Error('First submenu trigger has no bounds')
      }
      await page.mouse.move(start.x + start.width - 60, start.y + start.height / 2)
      await expect(first).toHaveAttribute('data-state', 'open')
      await page.mouse.wheel(0, 1)
      const menu = page.locator(`[data-slot="${kind}-menu-content"]`)
      await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      const from = await first.boundingBox()
      const to = await second.boundingBox()
      if (!from || !to) {
        throw new Error('Submenu triggers have no bounds')
      }
      // Cross the next row while moving diagonally toward the open submenu.
      await page.mouse.move(from.x + from.width - 60, from.y + from.height / 2)
      await page.mouse.move(from.x + from.width - 40, from.y + from.height / 2 + 1)
      await page.mouse.move(to.x + to.width - 20, to.y + 1)
      await expect(first).toHaveAttribute('data-state', 'open')
      await expect(second).toHaveAttribute('data-state', 'closed')
      const previousScroll = await menu.evaluate((element) => element.scrollTop)
      await page.mouse.wheel(0, 1)
      await expect
        .poll(() => menu.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(previousScroll)
      await expect(first).toHaveAttribute('data-state', 'open')
      await expect(second).toHaveAttribute('data-state', 'closed')
      await expect(second).not.toBeFocused()
      const child = page.getByRole('menuitem', { name: 'First child', exact: true })
      await child.hover()
      await expect(child).toBeFocused()
    })

    if (kind === 'dropdown') {
      test('keyboard reopening after wheel dismissal preserves the first item', async ({
        page
      }) => {
        const trigger = page.getByText('Open menu', { exact: true })
        const point = await center(page.getByRole('menuitem', { name: 'Row 3', exact: true }))
        const menu = page.locator('[data-slot="dropdown-menu-content"]')
        await page.mouse.move(point.x, point.y)
        await page.mouse.wheel(0, 96)
        await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
        await expectFocusedAtPointer(page, point)
        await trigger.click()
        await expect(menu).toBeHidden()
        await page.mouse.move(point.x, point.y)
        await trigger.focus()
        await page.keyboard.press('ArrowDown')
        await expect(menu).toBeVisible()
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        )
        await expect(page.getByRole('menuitem', { name: 'First', exact: true })).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(page.getByRole('menuitem', { name: 'First child', exact: true })).toBeVisible()
      })
    }

    test('submenu hover and keyboard navigation do not synthesize clicks', async ({ page }) => {
      const first = page.getByRole('menuitem', { name: 'First', exact: true })
      const second = page.getByRole('menuitem', { name: 'Second', exact: true })
      const start = await center(first)
      const destination = await center(second)
      await page.mouse.move(start.x, start.y)
      await expect(page.getByRole('menuitem', { name: 'First child', exact: true })).toBeVisible()
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-menu-clicks', '0')
        document.addEventListener('click', () => {
          const count = Number(document.documentElement.getAttribute('data-menu-clicks'))
          document.documentElement.setAttribute('data-menu-clicks', String(count + 1))
        })
      })
      // Moving away from the submenu uses Radix's normal sibling hover behavior.
      await page.mouse.move(destination.x - 35, destination.y, { steps: 5 })
      await expect(second).toBeFocused()
      await expect(second).toHaveAttribute('data-state', 'open')
      await expect(first).toHaveAttribute('data-state', 'closed')
      await expect(page.getByRole('menuitem', { name: 'Second child', exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'First child', exact: true })).toBeHidden()
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('menuitem', { name: 'Second child', exact: true })).toBeFocused()
      await page.keyboard.press('ArrowLeft')
      await expect(second).toBeFocused()
      await page.keyboard.press('ArrowUp')
      await expect(first).toBeFocused()
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('menuitem', { name: 'First child', exact: true })).toBeFocused()
      await expect(page.locator('html')).toHaveAttribute('data-menu-clicks', '0')
    })
  })
}
