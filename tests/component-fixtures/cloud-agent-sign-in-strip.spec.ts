import { expect, test, type Page } from '@playwright/test'

// AC-1 (agent-sign-in redesign §8): across every strip state at one pane width, the strip, its text
// column, its actions slot and the terminal's top edge sit in exactly the same boxes.

const WIDE = [
  'needExpired',
  'needExpiredCodex',
  'killSwitch',
  'notOffered',
  'waiting',
  'code',
  'codePaste',
  'wrongAccount',
  'error',
  'errorOffline',
  'portBusy',
  'done'
] as const
const NARROW = ['needNarrow', 'waitingNarrow'] as const

async function boxes(page: Page, id: string) {
  await page.goto(`/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:${id}`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const box = async (selector: string) => {
    const bounds = await page.locator(selector).first().boundingBox()
    if (!bounds) {
      throw new Error(`${selector} has no bounds in ${id}`)
    }
    return bounds
  }
  return {
    strip: await box('[data-cloud-sign-in-strip]'),
    text: await box('[data-strip-text]'),
    actions: await box('[data-strip-actions]'),
    terminalTop: (await box('pre')).y
  }
}

for (const [name, ids] of [
  ['wide', WIDE],
  ['narrow', NARROW]
] as const) {
  test(`${name}: every state keeps the same boxes, 56 px tall`, async ({ page }) => {
    const first = await boxes(page, ids[0])
    expect(first.strip.height).toBe(56)
    for (const id of ids.slice(1)) {
      expect(await boxes(page, id), id).toEqual(first)
    }
  })
}

// RA-1 real-app defects: the layout follows the strip's live width, and the pane's own title-row
// buttons stay clickable while the strip shows.
test('narrowing the pane after mount re-lays the strip out; the title stays readable', async ({
  page
}) => {
  await page.goto('/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:needExpired')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const strip = page.locator('[data-cloud-sign-in-strip]')
  await expect(strip).toHaveAttribute('data-strip-width', 'wide')
  for (const [width, layout, title] of [
    [520, 'tiny', 'Your Claude sign-in expired'],
    [320, 'compact', 'Claude sign-in expired']
  ] as const) {
    await page.locator('[data-strip-pane]').evaluate((pane, w) => {
      if (pane instanceof HTMLElement) {
        pane.style.width = `${w}px`
      }
    }, width)
    await expect(strip).toHaveAttribute('data-strip-width', layout)
    const titleBox = await strip.getByText(title, { exact: true }).boundingBox()
    // Readable: at least ~10 characters wide, never collapsed to one letter.
    await page.screenshot({ path: `/tmp/vdrv/strip-${width}.png` })
    expect(titleBox?.width ?? 0, `${width}px`).toBeGreaterThan(70)
    expect((await strip.boundingBox())?.height).toBe(56)
    await expect(strip.getByRole('button', { name: 'Renew' })).toBeVisible()
  }
})

test('the pane’s split and close buttons stay hit-testable above the strip', async ({ page }) => {
  for (const id of ['needExpired', 'killSwitch', 'needExpiredNarrow']) {
    await page.goto(`/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:${id}`)
    await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
    for (const name of ['Split pane', 'Close pane']) {
      const button = page.getByRole('button', { name, exact: true })
      const box = await button.boundingBox()
      if (!box) {
        throw new Error(`${name} has no bounds in ${id}`)
      }
      const hit = await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'),
        { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      )
      expect(hit, `${id}: ${name}`).toBe(name)
    }
  }
})
