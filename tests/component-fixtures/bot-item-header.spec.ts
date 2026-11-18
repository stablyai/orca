import { expect, test, type Locator, type Page } from '@playwright/test'

async function open(page: Page, fixture: string, theme = 'light'): Promise<void> {
  await page.goto(`/fixtures.html?id=bots/items/BotItemPane:${fixture}&theme=${theme}`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 30_000
  })
}

async function box(locator: Locator): Promise<{ y: number; height: number; bottom: number }> {
  const rect = (await locator.boundingBox())!
  return { y: rect.y, height: rect.height, bottom: rect.y + rect.height }
}

async function scrollTo(page: Page, to: 'top' | 'bottom'): Promise<void> {
  await page.getByRole('region').evaluate(async (root, where) => {
    root.scrollTop = where === 'top' ? 0 : root.scrollHeight
    root.dispatchEvent(new Event('scroll'))
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  }, to)
}

for (const theme of ['light', 'dark']) {
  test(`title, status and links stay in place from top to bottom (${theme})`, async ({ page }) => {
    await open(page, 'frozenTop', theme)
    const heading = page.getByRole('heading', { level: 2 })
    const links = page.getByRole('list', { name: 'Links' })
    const pr = links.getByRole('button', { name: /feat\(native-chat\)/ })
    const atTop = { heading: await box(heading), links: await box(links) }

    await scrollTo(page, 'bottom')
    await page.getByRole('textbox', { name: 'Comment' }).focus()

    // Nothing appears, moves or resizes as the activity scrolls under it.
    expect(await box(heading)).toEqual(atTop.heading)
    expect(await box(links)).toEqual(atTop.links)
    await expect(pr).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: 'In progress', exact: true })).toBeVisible()
    await expect(page.getByText('Update 12:')).toBeInViewport()
  })
}

test('a running worker chip shows its details card on focus, and Tab reaches its Stop', async ({
  page
}) => {
  await open(page, 'frozenScrolled')
  const links = page.getByRole('list', { name: 'Links' })
  const chip = links.getByRole('button', { name: /^C3 CHANGES REQUIRED/ })
  await chip.focus()
  const card = page.locator('[data-slot="hover-card-content"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('C3 CHANGES REQUIRED (2 P2) on 6b264e3e9cd')
  await expect(card).toContainText('Home Chat')

  await page.keyboard.press('Tab')
  await expect(
    links.getByRole('button', { name: 'Stop C3 CHANGES REQUIRED (2 P2) on 6b264e3e9cd' })
  ).toBeFocused()
})

test('the description, chat and done-means scroll away under the header', async ({ page }) => {
  await open(page, 'frozenTop')
  const description = page.getByText('Finish the share dialog from the design thread')
  await expect(description).toBeInViewport()
  await scrollTo(page, 'bottom')
  await expect(description).not.toBeInViewport()
  await expect(page.getByText('PR is open with screenshots')).not.toBeInViewport()
})

test('many links wrap to two lines and the rest sit behind +N', async ({ page }) => {
  await open(page, 'manyLinksTop')
  const links = page.getByRole('list', { name: 'Links' })
  expect((await box(links)).height).toBeLessThanOrEqual(52)
  const more = page.getByRole('button', { name: /^\d+ more links$/ })
  await expect(more).toBeVisible()
  const hidden = Number((await more.textContent())!.replace('+', ''))
  const reachable = await links.getByRole('listitem').count()
  expect(reachable + hidden).toBe(14)
  // Live work and the PR are among the chips in view; finished reviews are what overflow.
  await expect(links.getByRole('button', { name: /^C3 CHANGES REQUIRED/ })).toBeVisible()
  await expect(links.getByRole('button', { name: /feat\(native-chat\)/ })).toBeVisible()

  await more.click()
  const popover = page.getByRole('dialog')
  await expect(popover.getByRole('button')).toHaveCount(hidden)
  await expect(popover.getByRole('button', { name: /Review round 9/ })).toBeVisible()
})

test('Tab never lands on a clipped chip', async ({ page }) => {
  await open(page, 'manyLinksTop')
  const links = page.getByRole('list', { name: 'Links' })
  const chips = links.getByRole('button')
  await chips.last().focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: /^\d+ more links$/ })).toBeFocused()
})

// The right sidebar's height in a window this tall: the window less its title and status bars.
for (const [label, windowHeight, lines] of [
  ['default window', 1111, 2],
  ['short window', 600, 1]
] as const) {
  test(`the frozen top stays within a quarter of the pane (${label})`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: windowHeight })
    await open(page, 'manyLinksTop')
    const pane = page.locator('[data-bot-item-pane]')
    await pane.evaluate((node, height) => {
      node.parentElement!.style.height = `${height}px`
    }, windowHeight - 60)
    const links = page.getByRole('list', { name: 'Links' })
    expect((await box(links)).height).toBeLessThanOrEqual(lines * 24 + (lines - 1) * 4)
    await expect(page.getByRole('button', { name: /^\d+ more links$/ })).toBeVisible()
    const frame = await box(pane)
    // Back row, title, status and links, to the header's bottom edge.
    const frozen = (await box(links)).bottom + 8 - frame.y
    expect(frozen).toBeLessThanOrEqual(frame.height / 4)
  })
}

test('an item without links has no links row', async ({ page }) => {
  await open(page, 'noLinksScrolled')
  await expect(page.getByRole('heading', { level: 2 })).toBeInViewport()
  await expect(page.getByRole('list', { name: 'Links' })).toHaveCount(0)
})

for (const width of [260, 480]) {
  test(`reverse Tab brings a control out from under the header (${width}px)`, async ({ page }) => {
    await open(page, 'keyboard')
    await page.locator('#component-fixture-frame').evaluate((frame, paneWidth) => {
      frame.style.width = `${paneWidth}px`
    }, width)
    const scroller = page.getByRole('region')
    const links = page.getByRole('list', { name: 'Links' })
    const target = page.getByRole('button', { name: 'Show earlier', exact: true })
    // Park the control under the header, then Tab back to it from the comment box.
    await target.evaluate((button) => {
      const root = button.closest<HTMLElement>('[role="region"]')!
      root.scrollTop += button.getBoundingClientRect().top - root.getBoundingClientRect().top
      root.dispatchEvent(new Event('scroll'))
    })
    expect((await box(target)).y).toBeLessThan((await box(links)).bottom)
    await page.getByRole('textbox', { name: 'Comment' }).focus()

    await page.keyboard.press('Shift+Tab')

    await expect(target).toBeFocused()
    await expect
      .poll(async () => {
        const focused = await box(target)
        const viewport = await box(scroller)
        return focused.y >= (await box(links)).bottom && focused.bottom <= viewport.bottom
      })
      .toBe(true)
  })
}
