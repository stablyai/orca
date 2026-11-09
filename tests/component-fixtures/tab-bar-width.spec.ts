import { expect, test, type Locator, type Page } from '@playwright/test'

async function openFixture(page: Page, name: string) {
  await page.goto(`/fixtures.html?id=tab-bar/TabBar:${name}&theme=light`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  await page.evaluate(() => document.fonts.ready)
}

function slot(page: Page, id: string) {
  return page.locator(`[data-tab-strip-slot="${id}"]`)
}

async function width(element: Locator) {
  return element.evaluate((node) => node.getBoundingClientRect().width)
}

async function stripLayout(page: Page) {
  return page.locator('.terminal-tab-strip').evaluate((strip) => ({
    scrollLeft: strip.scrollLeft,
    scrollWidth: strip.scrollWidth,
    slots: Array.from(strip.querySelectorAll('[data-tab-strip-slot]'), (node) => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x, width: rect.width }
    })
  }))
}

test.use({ viewport: { width: 1900, height: 720 } })

for (const fixture of ['nonAgentTabs', 'nonAgentTabsOverflowing']) {
  test(`renaming reserves usable input space and keeps typing stable in ${fixture}`, async ({
    page
  }) => {
    await openFixture(page, fixture)
    for (const id of ['tab-0', 'file-0', 'tab-1', 'file-1']) {
      const label = slot(page, id).locator('.tab-label')
      await label.click()
      await label.scrollIntoViewIfNeeded()
      const before = await stripLayout(page)
      await label.dblclick()
      const input = slot(page, id).getByRole('textbox')
      await expect(input).toBeFocused()
      expect(await width(input)).toBeGreaterThanOrEqual(180)
      await input.scrollIntoViewIfNeeded()
      const editing = await stripLayout(page)
      await input.fill('A much longer replacement title '.repeat(8))
      expect(await stripLayout(page)).toEqual(editing)
      await input.press('Escape')
      await expect(input).toHaveCount(0)
      expect((await stripLayout(page)).slots.map((item) => item.width)).toEqual(
        before.slots.map((item) => item.width)
      )

      await label.dblclick()
      await expect(input).toBeFocused()
      await input.press('Enter')
      await expect(input).toHaveCount(0)
      expect((await stripLayout(page)).slots.map((item) => item.width)).toEqual(
        before.slots.map((item) => item.width)
      )
    }
  })
}

async function slotWidths(page: Page) {
  return (await stripLayout(page)).slots.map((item) => Math.round(item.width))
}

test.describe('tab sizing setting', () => {
  test('auto honors a custom max width', async ({ page }) => {
    await openFixture(page, 'sizingAutoMax180')
    expect(await width(slot(page, 'tab-0'))).toBe(180)
    expect(await width(slot(page, 'tab-1'))).toBe(180)
  })

  test('fit sizes every tab to its title', async ({ page }) => {
    await openFixture(page, 'sizingFit')
    expect(await width(slot(page, 'tab-1'))).toBeGreaterThan(await width(slot(page, 'tab-0')))
    expect(await width(slot(page, 'tab-0'))).toBeLessThan(300)
  })

  test('shrink lets short titles take less than the max width', async ({ page }) => {
    await openFixture(page, 'sizingShrink')
    expect(await width(slot(page, 'tab-2'))).toBeLessThan(300)
    expect(await width(slot(page, 'tab-2'))).toBeGreaterThanOrEqual(144)
  })

  test('fixed gives every tab the same width up to the max', async ({ page }) => {
    await openFixture(page, 'sizingFixed')
    expect(new Set(await slotWidths(page))).toEqual(new Set([300]))
  })

  test('fixed shrinks tabs equally down to a custom min width', async ({ page }) => {
    await openFixture(page, 'sizingFixedMin100')
    expect(new Set(await slotWidths(page))).toEqual(new Set([100]))
  })
})
