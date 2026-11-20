import { expect, test, type Page } from '@playwright/test'

// The first fixture page load also compiles the explorer.
test.describe.configure({ timeout: 120_000 })

const open = async (page: Page, fixture: string): Promise<void> => {
  await page.goto(`/fixtures.html?id=bots/BotSidebarVirtualRows:${fixture}&theme=light`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 60_000
  })
}

for (const [action, name] of [
  ['Shrink Bot 0', 'Bot 400'],
  ['Grow Bot 0', 'Bot 400'],
  ['Shrink Bot 0', 'Bot 749']
] as const) {
  test(`${action} while hidden, then reveal ${name}`, async ({ page }) => {
    await open(page, 'revealAfterHiddenShrink')
    await page.getByRole('button', { name: 'Hide list' }).click()
    await page.getByRole('button', { name: action }).click()
    await page.getByRole('button', { name: `Show list and reveal ${name}` }).click()

    const target = page.getByRole('button', { name, exact: true })
    await expect(target).toBeFocused()
    await expect(target).toBeInViewport()
  })
}

test('a bot that grows after its first measure pushes the next bot down', async ({ page }) => {
  // Whatever leaves a row's measured height stale: hold row resize reports once asked to.
  await page.addInitScript(() => {
    const Native = window.ResizeObserver
    window.ResizeObserver = class extends Native {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          const kept =
            document.documentElement.dataset.holdRowSizes !== undefined
              ? entries.filter((entry) => !entry.target.hasAttribute('data-index'))
              : entries
          if (kept.length > 0) {
            callback(kept, observer)
          }
        })
      }
    }
  })
  await open(page, 'growingRow')
  await page.evaluate(() => {
    document.documentElement.dataset.holdRowSizes = ''
  })
  await page.getByRole('button', { name: 'Add a chat line to Bot 1' }).click()

  const rows = page.locator('[data-bot-sidebar-entry]')
  await expect.poll(async () => (await rows.nth(1).boundingBox())?.height).toBe(80)
  const overlaps = await rows.evaluateAll((elements) =>
    elements.slice(1).flatMap((element, index) => {
      const above = elements[index]!.getBoundingClientRect()
      const top = element.getBoundingClientRect().top
      return top < above.bottom ? [`${element.textContent}: ${above.bottom - top}px`] : []
    })
  )
  expect(overlaps).toEqual([])
})
