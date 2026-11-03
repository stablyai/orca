import { expect, test, type Page } from '@playwright/test'

async function openFixture(page: Page, name: string) {
  await page.goto(`/fixtures.html?id=orchestration-crew/OrchestrationCrewPanel:${name}`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const card = page.getByRole('complementary', { name: 'Orchestration' })
  await expect(card).toBeVisible()
  const rows = card.locator('.overflow-y-auto')
  const bounds = await card.boundingBox()
  if (!bounds) {
    throw new Error('Card has no bounds')
  }
  // Ten workers never fit a short pane, so the rows must scroll inside the card.
  expect(await rows.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  return bounds
}

test('a saved opt-in keeps the suspended native chat card hidden and the composer visible', async ({
  page
}) => {
  await page.goto(
    '/fixtures.html?id=orchestration-crew/OrchestrationCrewPanel:tenWorkersShortChatExpanded'
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  await expect(page.getByRole('complementary', { name: 'Orchestration' })).toHaveCount(0)
  await expect(page.getByTestId('composer')).toBeVisible()
})

test('in a short terminal the card keeps the bottom quarter clear and scrolls', async ({
  page
}) => {
  const card = await openFixture(page, 'tenWorkersShortPaneExpanded')
  const pane = await page.locator('.pane').boundingBox()
  const limit = pane!.y + pane!.height * 0.75
  // It reaches the limit, since the rows are taller than the room, but never passes it.
  expect(card.y + card.height).toBeLessThanOrEqual(limit + 0.5)
  expect(card.y + card.height).toBeGreaterThan(limit - 2)
})

test('in a terminal at its minimum split height the collapse button stays clickable', async ({
  page
}) => {
  await page.goto(
    '/fixtures.html?id=orchestration-crew/OrchestrationCrewPanel:twoWorkersMinimumPaneExpanded'
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const collapse = page.getByRole('button', { name: 'Collapse orchestration panel' })
  const button = await collapse.boundingBox()
  const pane = await page.locator('.pane').boundingBox()
  // Aim at the part of the button the pane doesn't clip.
  const x = button!.x + button!.width / 2
  const y = (button!.y + Math.min(button!.y + button!.height, pane!.y + pane!.height)) / 2
  expect(y).toBeLessThan(pane!.y + pane!.height)
  await page.mouse.click(x, y)
  await expect(page.getByRole('complementary', { name: 'Orchestration' })).toHaveCount(0)
})

for (const [name, width] of [
  ['twoWorkersNarrowPaneExpanded', 100],
  ['twoWorkersMinimumWidthPaneExpanded', 50]
] as const) {
  test(`in a ${width}px-wide pane the whole collapse button fits inside the card`, async ({
    page
  }) => {
    await page.goto(`/fixtures.html?id=orchestration-crew/OrchestrationCrewPanel:${name}`)
    await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
    const card = await page.getByRole('complementary', { name: 'Orchestration' }).boundingBox()
    const collapse = page.getByRole('button', { name: 'Collapse orchestration panel' })
    const button = await collapse.boundingBox()
    expect(button!.x).toBeGreaterThanOrEqual(card!.x)
    expect(button!.x + button!.width).toBeLessThanOrEqual(card!.x + card!.width + 0.5)
    await collapse.click()
    await expect(page.getByRole('complementary', { name: 'Orchestration' })).toHaveCount(0)
  })
}
