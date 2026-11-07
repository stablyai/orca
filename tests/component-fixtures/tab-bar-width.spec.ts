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

test('content tabs use intrinsic widths and shrink to their minimum before overflowing', async ({
  page
}) => {
  await openFixture(page, 'nonAgentTabs')
  const strip = page.locator('.terminal-tab-strip')
  const assertWidths = async () => {
    for (const id of ['browser-0', 'file-0']) {
      expect(await width(slot(page, id))).toBeCloseTo(144, 0)
    }
    for (const id of ['tab-1', 'browser-1', 'file-1']) {
      expect(await width(slot(page, id))).toBeCloseTo(300, 0)
      const label = slot(page, id).locator('.tab-label')
      expect(await label.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
      expect(await label.evaluate((node) => getComputedStyle(node).textOverflow)).toBe('ellipsis')
    }
  }
  await assertWidths()
  expect(await strip.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(false)

  await page.locator('#component-fixture-frame').evaluate((node) => {
    node.style.width = '1280px'
  })
  for (const id of ['tab-0', 'tab-1', 'browser-1', 'file-1']) {
    await expect.poll(() => width(slot(page, id))).toBeGreaterThan(180)
    expect(await width(slot(page, id))).toBeLessThan(250)
  }
  expect(await strip.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(false)

  await page.locator('#component-fixture-frame').evaluate((node) => {
    node.style.width = '420px'
  })
  await expect(page.getByRole('button', { name: 'Scroll tabs right' })).toBeVisible()
  for (const id of ['tab-0', 'browser-0', 'file-0', 'tab-1', 'browser-1', 'file-1']) {
    expect(await width(slot(page, id))).toBeCloseTo(144, 0)
  }
  expect(await strip.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
  await test.info().attach('overflowing-content-tabs', {
    body: await page.locator('#component-fixture-frame').screenshot(),
    contentType: 'image/png'
  })
})

test('agent tabs keep their preferred width and share space down to their minimum', async ({
  page
}) => {
  await openFixture(page, 'twoTabs')
  expect(await width(slot(page, 'tab-0'))).toBeCloseTo(300, 0)
  expect(await width(slot(page, 'tab-1'))).toBeCloseTo(300, 0)
  await page.locator('#component-fixture-frame').evaluate((node) => {
    node.style.width = '420px'
  })
  await expect.poll(() => width(slot(page, 'tab-0'))).toBeLessThan(210)
  expect(await width(slot(page, 'tab-0'))).toBeGreaterThanOrEqual(144)
  expect(await width(slot(page, 'tab-0'))).toBeCloseTo(await width(slot(page, 'tab-1')), 0)

  await page.locator('#component-fixture-frame').evaluate((node) => {
    node.style.width = '280px'
  })
  await expect.poll(() => width(slot(page, 'tab-0'))).toBeCloseTo(144, 0)
  expect(await width(slot(page, 'tab-1'))).toBeCloseTo(144, 0)
  expect(
    await page
      .locator('.terminal-tab-strip')
      .evaluate((node) => node.scrollWidth > node.clientWidth)
  ).toBe(true)
})

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

test('long file tabs share available space before the strip overflows', async ({ page }) => {
  await openFixture(page, 'constrainedFiles')
  for (const id of ['file-0', 'file-1']) {
    expect(await width(slot(page, id))).toBeGreaterThan(240)
    expect(await width(slot(page, id))).toBeLessThan(270)
  }
  expect(
    await page
      .locator('.terminal-tab-strip')
      .evaluate((node) => node.scrollWidth > node.clientWidth)
  ).toBe(false)
})

test('terminal sizing stays stable as agent identity appears and disappears', async ({ page }) => {
  await openFixture(page, 'agentIdentityChanges')
  for (let index = 0; index < 3; index++) {
    expect(await width(slot(page, 'tab-0'))).toBeCloseTo(300, 0)
    expect(await width(slot(page, 'tab-1'))).toBeCloseTo(300, 0)
    await page.getByRole('button', { name: 'Toggle agent identity' }).click()
  }
})
