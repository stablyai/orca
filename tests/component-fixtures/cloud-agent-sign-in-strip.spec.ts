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
    terminalTop: (await box('.xterm-container')).y
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
    const titleLine = strip.locator('[data-strip-text] > span').first()
    await expect(titleLine).toHaveText(title)
    // Readable: at least ~10 characters wide, never collapsed to one letter (once laid out).
    await expect
      .poll(async () => (await titleLine.boundingBox())?.width ?? 0, { message: `${width}px` })
      .toBeGreaterThan(70)
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

// RA-11 + #315 P2: the strip reserves its height; the terminal refits below it, so no row (and not
// the last one) ever sits under the strip, held launch or running agent alike.
test('the terminal starts below the strip and its last row stays visible', async ({ page }) => {
  for (const id of [
    'needExpired',
    'runningExpired',
    'runningRenewed',
    'runningExpiredCompact',
    'runningRestarting',
    'runningRestartFailed'
  ]) {
    await page.goto(`/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:${id}`)
    await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
    const strip = await page.locator('[data-cloud-sign-in-strip]').boundingBox()
    const terminal = await page.locator('.xterm-container').boundingBox()
    const lastRow = await page.locator('[data-terminal-last-row]').boundingBox()
    const pane = await page.locator('[data-strip-pane]').boundingBox()
    if (!strip || !terminal || !lastRow || !pane) {
      throw new Error(`missing bounds in ${id}`)
    }
    expect(terminal.y, id).toBeGreaterThanOrEqual(strip.y + strip.height)
    expect(lastRow.y, id).toBeGreaterThanOrEqual(strip.y + strip.height)
    expect(lastRow.y + lastRow.height, id).toBeLessThanOrEqual(pane.y + pane.height)
  }
})

test('RA-11: state 1 offers Renew only; state 2 offers Restart and a dismiss clear of the pane buttons', async ({
  page
}) => {
  await page.goto('/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:runningExpired')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const strip = page.locator('[data-cloud-sign-in-strip]')
  await expect(strip).toContainText('Renew to keep working. Your conversation is kept.')
  await expect(strip.getByRole('button')).toHaveCount(1)
  await page.goto('/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:runningRenewed')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  await expect(strip).toContainText('Restart Claude to pick up where you left off.')
  await expect(strip.getByRole('button', { name: 'Restart Claude' })).toBeVisible()
  const dismiss = await strip.getByRole('button', { name: 'Dismiss' }).boundingBox()
  const close = await page.getByRole('button', { name: 'Close pane', exact: true }).boundingBox()
  if (!dismiss || !close) {
    throw new Error('missing bounds')
  }
  // Not stacked next to the pane's ×: the strip sits a whole title row lower.
  expect(dismiss.y).toBeGreaterThanOrEqual(close.y + close.height)
})

test('RA-11 Restart: "Restarting Claude…" is the spinner and words only; a failure offers Try again once', async ({
  page
}) => {
  await page.goto('/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:runningRestarting')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const strip = page.locator('[data-cloud-sign-in-strip]')
  await expect(strip).toContainText('Restarting Claude…')
  await expect(strip).not.toContainText('Picking up where you left off.')
  // Nothing to click twice, nothing to close: the strip leaves with a result.
  await expect(strip.getByRole('button')).toHaveCount(0)
  await page.goto(
    '/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:runningRestartFailed'
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  await expect(strip).toContainText('Couldn’t restart Claude')
  // The visible body is the reason, never a second "Try again." (the polite region may repeat it).
  const body = strip.locator('[data-strip-text] > span').nth(1)
  await expect(body).toHaveText('The workspace didn’t respond.')
  await expect(strip.getByRole('button', { name: 'Try again' })).toBeEnabled()
  await expect(strip.getByRole('button', { name: 'Dismiss' })).toBeVisible()
})

test('PC-3b: not set up is neutral (no loading ring), and a narrow paste strip keeps one line', async ({
  page
}) => {
  await page.goto('/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:notSetUp')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const strip = page.locator('[data-cloud-sign-in-strip]')
  await expect(strip.locator('svg.lucide-info')).toHaveCount(1)
  await expect(strip.locator('svg.lucide-circle-dashed')).toHaveCount(0)
  await page.goto('/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:notSetUpPasteTiny')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const detail = strip.locator('[data-strip-text] > span').nth(1)
  // Not on the line (no truncated "never to a sand…"), still the region's description.
  await expect(detail).toHaveClass(/sr-only/)
  await expect(detail).toContainText('never to a sandbox')
  await expect(strip.locator('svg.lucide-info')).toHaveCount(1)
})
