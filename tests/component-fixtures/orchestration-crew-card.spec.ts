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

test('in a short native chat the card stops above the composer and scrolls', async ({ page }) => {
  const card = await openFixture(page, 'tenWorkersShortChatExpanded')
  const composer = await page.getByTestId('composer').boundingBox()
  expect(card.y + card.height).toBeLessThanOrEqual(composer!.y)
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
