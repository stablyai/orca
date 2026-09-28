import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('all account meters remain readable in both usage surfaces', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const state = store.getState()
    const now = Date.now()
    const accounts = ['personal', 'work'].map((id) => ({
      id,
      email: `${id}@example.test`,
      managedAuthPath: `/test-only/${id}`,
      authMethod: 'subscription-oauth' as const,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now
    }))
    const makeUsage = (usedPercent: number) => ({
      provider: 'claude' as const,
      session: {
        usedPercent,
        windowMinutes: 300,
        resetsAt: now + 3600_000,
        resetDescription: null
      },
      weekly: {
        usedPercent: usedPercent + 5,
        windowMinutes: 10080,
        resetsAt: now + 86_400_000,
        resetDescription: null
      },
      updatedAt: now,
      error: null,
      status: 'ok' as const
    })
    store.setState({
      settings: {
        ...state.settings!,
        claudeManagedAccounts: accounts,
        activeClaudeManagedAccountId: 'personal',
        activeClaudeManagedAccountIdsByRuntime: { host: 'personal', wsl: {} }
      },
      rateLimits: {
        ...state.rateLimits,
        claude: makeUsage(8),
        inactiveClaudeAccounts: [
          { accountId: 'work', rateLimits: makeUsage(58), updatedAt: now, isFetching: false }
        ]
      },
      statusBarVisible: true,
      statusBarItems: ['claude'],
      detectedAgentIds: ['claude'],
      statusBarUsageMode: 'verbose',
      usagePercentageDisplay: 'used',
      // The fixture supplies usage; no test identity is sent to a credential service.
      fetchInactiveClaudeAccountUsage: async () => {},
      fetchInactiveCodexAccountUsage: async () => {},
      refreshRateLimits: async () => {}
    })
  })
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  for (const theme of ['light', 'dark']) {
    await orcaPage.evaluate((value) => {
      document.documentElement.classList.toggle('dark', value === 'dark')
    }, theme)
    for (const width of [1440, 640]) {
      await orcaPage.setViewportSize({ width, height: 900 })
      const footer = orcaPage.getByRole('button', { name: 'Usage', exact: true })
      await expect(footer).toContainText('personal@example.test')
      await expect(footer).toContainText('work@example.test')
      const bounds = await footer.evaluate((node) => {
        const anchor = node.parentElement!
        const group = anchor.parentElement!
        return {
          right: node.getBoundingClientRect().right,
          availableRight: group.getBoundingClientRect().right
        }
      })
      expect(bounds.right).toBeLessThanOrEqual(bounds.availableRight + 1)
      await footer.click()
      const menu = orcaPage.getByRole('menu').first()
      for (const mode of ['Detailed', 'Compact']) {
        await menu.getByRole('radio', { name: mode, exact: true }).click()
        await expect(menu).toContainText('personal@example.test')
        await expect(menu).toContainText('work@example.test')
        await expect(menu).toContainText('63%')
        await expect(footer).toContainText('63%')
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(
          testInfo.outputPath(`usage-${theme}-${width}-${mode}.png`),
          Buffer.from(shot.data, 'base64')
        )
      }
      await orcaPage.keyboard.press('Escape')
      await expect(menu).not.toBeVisible()
    }
  }
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
  await cdp.detach()
})
