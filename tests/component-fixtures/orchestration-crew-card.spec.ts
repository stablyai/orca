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

test('a saved orchestration opt-in keeps the native panel hidden and composer available', async ({
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

for (const name of ['terminalQuestionDetails']) {
  for (const width of [280, 360]) {
    test(`${name} keeps long expanded details inside a ${width}px frame`, async ({ page }) => {
      await page.goto(`/fixtures.html?id=orchestration-crew/OrchestrationCrewPanel:${name}`)
      await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
      const frame = page.locator('#component-fixture-frame')
      await frame.evaluate((element, frameWidth) => {
        element.style.width = `${frameWidth}px`
      }, width)
      const card = page.getByRole('complementary', { name: 'Orchestration' })
      const details = card.locator('dl')
      await expect(details).toBeVisible()
      await expect(details).toContainText('dispatched')
      expect(await details.innerText()).toContain('unbroken'.repeat(128))
      const overflow = await details.evaluate((element) => {
        const card = element.closest('aside')!
        const bounds = card.getBoundingClientRect()
        const violations: string[] = []
        for (const value of element.querySelectorAll('dd')) {
          const rect = value.getBoundingClientRect()
          if (rect.left < bounds.left || rect.right > bounds.right + 1) {
            violations.push('detail value outside card')
          }
          if (value.scrollWidth > value.clientWidth + 1) {
            violations.push('detail value scrolls horizontally')
          }
          const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const range = document.createRange()
            range.selectNodeContents(walker.currentNode)
            for (const line of range.getClientRects()) {
              if (line.left < bounds.left || line.right > bounds.right + 1) {
                violations.push('text outside card')
              }
            }
          }
        }
        return violations
      })
      await test.info().attach('expanded-details', {
        body: await frame.screenshot(),
        contentType: 'image/png'
      })
      expect(overflow).toEqual([])
      await card.getByRole('button', { name: /^Show .*task and latest message$/ }).click()
      await expect(details).toHaveCount(0)
    })
  }
}
