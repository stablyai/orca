import { expect, test, type Locator, type Page } from '@playwright/test'

const FIXTURE = 'tab-group/TabGroupSplitLayout.focused-underline'

test.use({ viewport: { width: 1400, height: 400 } })
// Why: the first fixture load waits on a cold Vite dependency scan.
test.describe.configure({ timeout: 120_000 })

async function open(page: Page, fixture: string, theme: string): Promise<void> {
  await page.goto(`/fixtures.html?id=${FIXTURE}:${fixture}&theme=${theme}`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 90_000
  })
}

/** The active-tab underline in one group's tab strip. */
function underline(page: Page, groupIndex: number): Locator {
  return page
    .locator('[data-tab-group-strip-id]')
    .nth(groupIndex)
    .locator('[data-active="true"] .bg-tab-active-indicator')
}

for (const theme of ['light', 'dark']) {
  test(`only the focused split group's active tab is underlined (${theme})`, async ({ page }) => {
    await open(page, 'focusLeftGroup', theme)
    await expect(underline(page, 0)).toBeVisible()
    await expect(underline(page, 1)).toBeHidden()

    // Pointer into the other group moves the underline there.
    await page.getByText('review.ts', { exact: true }).click()
    await expect(underline(page, 1)).toBeVisible()
    await expect(underline(page, 0)).toBeHidden()

    // Leaving the groups (sidebar, titlebar, a dialog) keeps the last focused group's underline.
    await page.mouse.click(1390, 390)
    await expect(underline(page, 1)).toBeVisible()
    await expect(underline(page, 0)).toBeHidden()

    // Keyboard focus entering a group moves it too.
    await page.locator('[data-tab-group-strip-id]').nth(0).locator('[data-active="true"]').focus()
    await expect(underline(page, 0)).toBeVisible()
    await expect(underline(page, 1)).toBeHidden()
  })

  test(`a single group keeps its active tab underlined (${theme})`, async ({ page }) => {
    await open(page, 'singleGroup', theme)
    await expect(underline(page, 0)).toBeVisible()
  })
}
