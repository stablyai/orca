import { expect, test, type Page } from '@playwright/test'

type HeaderLayout = {
  prefixWidth: number
  prefixClipped: boolean
  nameClipped: boolean
  nameWidth: number
  countsShown: boolean
  dirtyShown: boolean
  chevronShown: boolean
  actionsShown: number
}

// Real-browser layout: flex shrinking, ellipsis and container queries do not exist in jsdom.
async function measure(page: Page, width: number): Promise<HeaderLayout> {
  return page.getByTestId(`diff-header-${width}`).evaluate((root) => {
    const shown = (el: Element | null) => !!el && el.getBoundingClientRect().width > 0
    const find = (selector: string): HTMLElement => {
      const found = root.querySelector<HTMLElement>(selector)
      if (!found) {
        throw new Error(`fixture header has no ${selector}`)
      }
      return found
    }
    const prefix = find('.path-display-prefix')
    const name = find('.path-display-file')
    const dirty = [...root.querySelectorAll('span')].find((span) => span.textContent === 'M')
    return {
      prefixWidth: prefix.getBoundingClientRect().width,
      prefixClipped: prefix.scrollWidth > prefix.clientWidth,
      nameClipped: name.scrollWidth > name.clientWidth,
      nameWidth: name.getBoundingClientRect().width,
      countsShown: shown(root.querySelector('.diff-section-header-counts')),
      dirtyShown: shown(dirty ?? null),
      chevronShown: shown(root.querySelector('button[aria-expanded]')),
      actionsShown: [...root.querySelectorAll('button')].filter((button) => shown(button)).length
    }
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/fixtures.html?id=editor/diff/sections/DiffSectionHeader:narrowWidths')
  // The fixture pulls in editor modules; a cold dev server under parallel workers can take seconds.
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 30_000
  })
})

test('the file name never shrinks while any of its folder is still shown', async ({ page }) => {
  // Sweep one header through every width; the overlap only shows in a narrow band.
  const clippedWithFolder = await page.getByTestId('diff-header-520').evaluate((root) => {
    const find = (selector: string): HTMLElement => {
      const found = root.querySelector<HTMLElement>(selector)
      if (!found) {
        throw new Error(`fixture header has no ${selector}`)
      }
      return found
    }
    const prefix = find('.path-display-prefix')
    const name = find('.path-display-file')
    // Compare against the text's exact width: a weighted shrink can take sub-pixel amounts from the name.
    const range = document.createRange()
    range.selectNodeContents(name)
    const textWidth = range.getBoundingClientRect().width
    const bad: number[] = []
    for (let width = 520; width >= 100; width -= 1) {
      root.style.width = `${width}px`
      const nameWidth = name.getBoundingClientRect().width
      if (prefix.getBoundingClientRect().width > 0 && nameWidth < textWidth - 0.01) {
        bad.push(width)
      }
    }
    root.style.width = '520px'
    return bad
  })
  expect(clippedWithFolder).toEqual([])
})

test('a wide header shows the whole path and its counts', async ({ page }) => {
  const layout = await measure(page, 520)
  expect(layout).toMatchObject({ prefixClipped: false, nameClipped: false, countsShown: true })
})

test('a narrow header drops counts first but keeps the unsaved mark, chevron and actions', async ({
  page
}) => {
  const layout = await measure(page, 240)
  expect(layout).toMatchObject({
    countsShown: false,
    dirtyShown: true,
    chevronShown: true,
    actionsShown: 3
  })
})

test('the narrowest header gives the name all the room and ellipsizes it', async ({ page }) => {
  const layout = await measure(page, 120)
  expect(layout.prefixWidth).toBe(0)
  expect(layout.nameWidth).toBeGreaterThan(0)
  expect(layout).toMatchObject({
    nameClipped: true,
    dirtyShown: true,
    chevronShown: true,
    actionsShown: 3
  })
})

test('the section toggle is a named, focusable button that Enter and Space each flip once', async ({
  page
}) => {
  const header = page.getByTestId('diff-header-120')
  const collapse = header.getByRole('button', { name: 'Collapse release-checklist.md' })
  await expect(collapse).toBeVisible()
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')

  // Reach it by keyboard, as a keyboard user would, so focus-visible styling applies.
  await header.getByRole('button', { name: 'Open in editor' }).focus()
  await page.keyboard.press('Tab')
  await expect(collapse).toBeFocused()
  await expect(collapse).toHaveCSS('box-shadow', /rgb/)

  // One press is one toggle: the header row's own click handler must not toggle it back.
  await page.keyboard.press('Enter')
  const expand = header.getByRole('button', { name: 'Expand release-checklist.md' })
  await expect(expand).toHaveAttribute('aria-expanded', 'false')
  await expect(expand).toBeFocused()

  await page.keyboard.press('Space')
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
})
