import { expect, test, type Locator, type Page } from '@playwright/test'

// The visible gap between an answer's last block and its actions, at the default chat typography.
// Every ending gets the same gap; before the actions owned it, a paragraph got 4px and a list 10px.
test.use({ viewport: { width: 1000, height: 720 } })

const GAP = 12

const LAST_BLOCK: Record<string, (page: Page) => Locator> = {
  paragraph: (page) => page.getByText('Nothing changed since the last check.', { exact: true }),
  list: (page) => page.getByText('Release notes', { exact: true }),
  code: (page) => page.locator('[data-native-chat-code-block]').last()
}

for (const [ending, lastBlock] of Object.entries(LAST_BLOCK)) {
  test(`an answer ending in a ${ending} keeps a ${GAP}px gap above its actions`, async ({
    page
  }) => {
    await page.goto(
      `/fixtures.html?id=native-chat/messages/rows/NativeChatActionsGap:${ending}&theme=light`
    )
    // A cold server compiles the whole chat graph on first load.
    await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
      timeout: 60_000
    })
    const earlier = page.getByText('Two items moved to done.', { exact: true })
    await expect(earlier).toHaveCSS('font-size', '13px')
    await expect(earlier).toHaveCSS('line-height', '20px')
    const block = await lastBlock(page).boundingBox()
    const actions = await page
      .getByRole('button', { name: 'Scroll this message to top' })
      .last()
      .locator('..')
      .boundingBox()
    if (!block || !actions) {
      throw new Error('The answer or its actions did not render')
    }
    expect(actions.y - (block.y + block.height)).toBeCloseTo(GAP, 0)
  })
}
