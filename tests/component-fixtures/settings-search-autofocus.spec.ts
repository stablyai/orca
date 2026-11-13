import { expect, test, type Locator, type Page } from '@playwright/test'

const SIDES = ['top', 'bottom', 'left', 'right'] as const

/** Pixels in the 4px band just outside the field, where a focus halo would paint. */
async function bandAround(page: Page, field: Locator): Promise<Buffer[]> {
  const box = await field.boundingBox()
  if (!box) {
    throw new Error('Search field has no bounds')
  }
  const pad = 4
  const clips = [
    { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: pad },
    { x: box.x - pad, y: box.y + box.height, width: box.width + 2 * pad, height: pad },
    { x: box.x - pad, y: box.y, width: pad, height: box.height },
    { x: box.x + box.width, y: box.y, width: pad, height: box.height }
  ]
  return Promise.all(clips.map((clip) => page.screenshot({ clip, animations: 'disabled' })))
}

test('the autofocused Settings search paints nothing outside its border', async ({ page }) => {
  await page.goto(
    '/fixtures.html?id=settings/navigation/SettingsSidebarSearch:autoFocused&theme=light'
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const search = page.getByRole('combobox', { name: 'Search settings' })
  await expect(search).toBeFocused()
  const focused = await bandAround(page, search)

  await search.blur()
  await expect(search).not.toBeFocused()
  const blurred = await bandAround(page, search)
  expect(SIDES.filter((_, index) => !blurred[index].equals(focused[index]))).toEqual([])
})
