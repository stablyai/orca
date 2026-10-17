import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('inactive account countdowns remain readable at enlarged text size', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const settings = store.getState().settings
    if (!settings) {
      throw new Error('Settings did not load')
    }
    const now = Date.now()
    const usage = {
      provider: 'claude' as const,
      session: {
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: now + 6 * 24 * 60 * 60_000 + 7 * 60 * 60_000 + 5_000,
        resetDescription: null
      },
      weekly: {
        usedPercent: 75,
        windowMinutes: 10_080,
        resetsAt: now + 6 * 24 * 60 * 60_000 + 7 * 60 * 60_000 + 5_000,
        resetDescription: null
      },
      fableWeekly: {
        usedPercent: 50,
        windowMinutes: 10_080,
        resetsAt: now + 6 * 24 * 60 * 60_000 + 7 * 60 * 60_000 + 5_000,
        resetDescription: null
      },
      updatedAt: now,
      error: null,
      status: 'ok' as const
    }
    store.setState({
      settings: {
        ...settings,
        claudeManagedAccounts: [
          {
            id: 'fixture-account',
            email: 'fixture@example.invalid',
            managedAuthPath: 'fixture',
            authMethod: 'unknown',
            createdAt: now,
            updatedAt: now,
            lastAuthenticatedAt: now
          }
        ]
      },
      rateLimits: {
        ...store.getState().rateLimits,
        claude: usage,
        inactiveClaudeAccounts: [
          { accountId: 'fixture-account', rateLimits: usage, updatedAt: now, isFetching: false }
        ]
      },
      fetchInactiveClaudeAccountUsage: async () => {}
    })
  })

  await orcaPage.locator('button[aria-label]:has([data-usage-bar])').click()
  await orcaPage.getByRole('menuitem', { name: /Claude/ }).hover()
  await orcaPage
    .getByRole('menu', { name: /Claude/ })
    .getByRole('menuitem')
    .first()
    .click()
  const label = orcaPage.getByText('Fable 6d 7h', { exact: true })
  await expect(label).toBeVisible()
  await orcaPage.evaluate(() => {
    const label = [...document.querySelectorAll('span')].find(
      (element) => element.textContent === 'Fable 6d 7h'
    )
    const usage = label?.parentElement?.parentElement
    for (const span of usage?.querySelectorAll('span') ?? []) {
      span.style.fontSize = '20px'
    }
  })
  await expect
    .poll(() =>
      label.evaluate((element) => ({
        clippedText: [
          ...(element.parentElement?.parentElement?.querySelectorAll('span') ?? [])
        ].some((span) => {
          const row = span.parentElement?.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(span)
          return [...range.getClientRects()].some(
            (rect) =>
              !row ||
              rect.left < row.left - 1 ||
              rect.right > row.right + 1 ||
              rect.top < row.top - 3 ||
              rect.bottom > row.bottom + 3
          )
        }),
        rowsOverlap: [...(element.parentElement?.parentElement?.children ?? [])].some(
          (row, index, rows) =>
            index > 0 &&
            rows[index - 1].getBoundingClientRect().bottom > row.getBoundingClientRect().top
        )
      }))
    )
    .toEqual({ clippedText: false, rowsOverlap: false })
})
