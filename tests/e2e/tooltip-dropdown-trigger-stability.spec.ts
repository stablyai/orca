import type { Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function expectTooltipClosed(page: Page, text: string): Promise<void> {
  const content = page.locator('[data-slot="tooltip-content"]').filter({ hasText: text })
  await expect
    .poll(() =>
      content.evaluateAll((elements) =>
        elements.every((element) => element.getAttribute('data-state') === 'closed')
      )
    )
    .toBe(true)
  await expect(content).toHaveCount(0)
}

async function exerciseMenuTrigger(page: Page, button: Locator, text: string): Promise<void> {
  await page.mouse.move(400, 400)
  await button.blur()
  await expectTooltipClosed(page, text)
  await button.hover()
  await expect(page.getByRole('tooltip').filter({ hasText: text })).toBeVisible()
  await page.mouse.move(400, 400)
  await expectTooltipClosed(page, text)

  await button.focus()
  await expect(button).toBeFocused()
  await expect(button).toHaveAccessibleDescription(text)
  await expect(page.getByRole('tooltip').filter({ hasText: text })).toBeVisible()

  await button.blur()
  await expectTooltipClosed(page, text)

  for (const input of ['keyboard', 'pointer'] as const) {
    if (input === 'keyboard') {
      await button.focus()
      await page.keyboard.press('Enter')
    } else {
      await button.click()
    }
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect
      .poll(() => menu.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true)
    // A menu item's tooltip can consume the first Escape.
    await page.keyboard.press('Escape')
    if (
      await menu.evaluateAll((elements) =>
        elements.some((element) => element.getAttribute('data-state') === 'open')
      )
    ) {
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0)
      await page.keyboard.press('Escape')
    }
    await expect(page.getByRole('menu')).toBeHidden()
    await expect(button).toBeFocused()
  }
}

for (const surface of [
  {
    name: 'source control header',
    openButton: /^Source Control/,
    closeButton: /^Explorer/,
    triggerLabel: 'More source control actions',
    tooltip: 'More source control actions'
  },
  {
    name: 'commit actions',
    openButton: /^Source Control/,
    closeButton: /^Explorer/,
    triggerLabel: 'More commit and remote actions',
    tooltip: 'More commit and remote actions'
  },
  {
    name: 'activity options',
    openButton: 'View activity',
    closeButton: 'Turn off activity view',
    triggerLabel: 'Thread list options',
    tooltip: 'Activity options'
  }
] as const) {
  test(`${surface.name} menu button retains tooltip descriptions through focus, hover and remounts`, async ({
    orcaPage: page
  }) => {
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    const errors: string[] = []
    const captureError = (error: Error): void => {
      errors.push(error.message)
    }
    page.on('pageerror', captureError)
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await page.getByRole('button', { name: surface.openButton, exact: true }).click()
        await exerciseMenuTrigger(
          page,
          page.getByRole('button', { name: surface.triggerLabel, exact: true }),
          surface.tooltip
        )
        await page.getByRole('button', { name: surface.closeButton, exact: true }).click()
        await expect(
          page.getByRole('button', { name: surface.triggerLabel, exact: true })
        ).toHaveCount(0)
        expect(errors).toEqual([])
      }
    } finally {
      page.off('pageerror', captureError)
    }
  })
}
