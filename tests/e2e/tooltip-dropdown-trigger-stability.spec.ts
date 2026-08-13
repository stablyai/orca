import type { ConsoleMessage, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type RendererErrors = {
  pageErrors: string[]
  consoleErrors: string[]
  stop: () => void
}

function captureRendererErrors(page: Page): RendererErrors {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const onPageError = (error: Error): void => {
    pageErrors.push(error.message)
  }
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  }
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  return {
    pageErrors,
    consoleErrors,
    stop: () => {
      page.off('pageerror', onPageError)
      page.off('console', onConsole)
    }
  }
}

async function expectTooltipOwnedByButton(
  page: Page,
  button: Locator,
  tooltipText: string
): Promise<void> {
  await button.focus()
  const tooltip = page.getByRole('tooltip').filter({ hasText: tooltipText }).last()
  await expect(tooltip).toBeVisible({ timeout: 3_000 })
  await expect
    .poll(
      () =>
        button.evaluate((element) => {
          const describedBy = element.getAttribute('aria-describedby')?.split(/\s+/) ?? []
          return describedBy.some((id) => {
            const description = document.getElementById(id)
            return (
              description?.getAttribute('role') === 'tooltip' && description.offsetParent !== null
            )
          })
        }),
      { timeout: 3_000 }
    )
    .toBe(true)

  await page.mouse.move(1, 1)
  await button.evaluate((element) => (element as HTMLElement).blur())
  await expectTooltipDismissed(page, tooltipText)

  await button.hover()
  await expect(tooltip).toBeVisible({ timeout: 3_000 })
  await page.mouse.move(1, 1)
  await expectTooltipDismissed(page, tooltipText)
}

// Why: getByRole('tooltip') hits Radix's aria span that lingers through the throttled
// exit animation; the content's data-state flips to 'closed' immediately on dismiss.
async function expectTooltipDismissed(page: Page, tooltipText: string): Promise<void> {
  const content = page.locator('[data-slot="tooltip-content"]').filter({ hasText: tooltipText })
  await expect
    .poll(
      async () => {
        // Why: leftover closing tooltips can also match the filter.
        const states = await content.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-state'))
        )
        return states.every((state) => state === 'closed')
      },
      { timeout: 5_000 }
    )
    .toBe(true)
}

async function exerciseTooltipMenuControl(
  page: Page,
  button: Locator,
  tooltipText: string
): Promise<void> {
  await expectTooltipOwnedByButton(page, button, tooltipText)

  await button.click()
  const menu = page.getByRole('menu').last()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  await button.click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
}

async function closeFileExplorer(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.getState().setRightSidebarTab('source-control')
  })
  await expect(page.getByRole('button', { name: 'More Explorer Actions' })).toHaveCount(0)
}

async function openActivity(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({ experimentalActivity: true })
    window.__store?.setState({ settings })
  })
  const agents = page.getByRole('button', { name: /^Agents(?:\s+\d+)?$/ }).first()
  await expect(agents).toBeVisible()
  await agents.click()
  await expect(page.getByRole('button', { name: 'Thread list options' })).toBeVisible()
}

async function closeActivity(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.getState().closeActivityPage()
  })
  await expect(page.getByRole('button', { name: 'Thread list options' })).toHaveCount(0)
}

const SOURCE_CONTROL_TRIGGER_CASES = [
  ['More source control actions', 'More source control actions'],
  ['More commit and remote actions', 'More commit and remote actions']
] as const

async function openSourceControl(page: Page): Promise<void> {
  const sourceControl = page.getByRole('button', { name: /^Source Control/ }).first()
  await expect(sourceControl).toBeVisible()
  await sourceControl.click()
  for (const [label] of SOURCE_CONTROL_TRIGGER_CASES) {
    await expect(page.getByRole('button', { name: label })).toBeVisible({ timeout: 10_000 })
  }
}

async function closeSourceControl(page: Page): Promise<void> {
  const explorer = page.getByRole('button', { name: /^Explorer/ }).first()
  await expect(explorer).toBeVisible()
  await explorer.click()
  for (const [label] of SOURCE_CONTROL_TRIGGER_CASES) {
    await expect(page.getByRole('button', { name: label })).toHaveCount(0)
  }
}

function expectNoRendererErrors(errors: RendererErrors): void {
  expect(errors.pageErrors, `pageerror: ${errors.pageErrors.join('\n')}`).toEqual([])
  expect(errors.consoleErrors, `console.error: ${errors.consoleErrors.join('\n')}`).toEqual([])
}

test.describe('Tooltip and menu trigger stability', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('direct File Explorer trigger survives focus, hover, menus, and remounts', async ({
    orcaPage
  }) => {
    const errors = captureRendererErrors(orcaPage)
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await openFileExplorer(orcaPage)
        const button = orcaPage.getByRole('button', { name: 'More Explorer Actions' })
        await expect(button).toBeVisible()
        await exerciseTooltipMenuControl(orcaPage, button, 'More Explorer Actions')
        await closeFileExplorer(orcaPage)
      }
      expectNoRendererErrors(errors)
    } finally {
      errors.stop()
    }
  })

  test('Activity trigger keeps tooltip ownership through menu remounts', async ({ orcaPage }) => {
    const errors = captureRendererErrors(orcaPage)
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await openActivity(orcaPage)
        const button = orcaPage.getByRole('button', { name: 'Thread list options' })
        await exerciseTooltipMenuControl(orcaPage, button, 'More options')
        await closeActivity(orcaPage)
      }
      expectNoRendererErrors(errors)
    } finally {
      errors.stop()
    }
  })

  test('Source Control compound triggers survive focus, menus, and remounts', async ({
    orcaPage
  }) => {
    const errors = captureRendererErrors(orcaPage)
    test.setTimeout(240_000)
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await openSourceControl(orcaPage)
        for (const [label, tooltip] of SOURCE_CONTROL_TRIGGER_CASES) {
          await exerciseTooltipMenuControl(
            orcaPage,
            orcaPage.getByRole('button', { name: label }),
            tooltip
          )
        }
        await closeSourceControl(orcaPage)
      }
      expectNoRendererErrors(errors)
    } finally {
      errors.stop()
    }
  })
})
