import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('Cursor usage follows the footer detail control in a hidden renderer', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' }))
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  const board = orcaPage.locator('[data-workspace-board-trigger]')
  await board.click()
  await board.click()
  await orcaPage.mouse.move(1000, 200)
  await expect(orcaPage.getByText('Workspace board moved to the bottom bar')).not.toBeVisible({
    timeout: 10_000
  })
  const clip = await orcaPage.evaluate(() => ({
    x: 0,
    y: window.innerHeight - 320,
    width: Math.min(window.innerWidth, 1000),
    height: 320
  }))
  await orcaPage.evaluate(() => {
    const store = window.__store!
    store.setState({
      statusBarVisible: true,
      statusBarItems: ['cursor'],
      statusBarUsageMode: 'verbose',
      usagePercentageDisplay: 'used',
      detectedAgentIds: ['cursor'],
      rateLimits: { ...store.getState().rateLimits, cursor: null, cursorAuthConfigured: false }
    })
  })
  const usage = orcaPage.getByRole('button', { name: 'Usage', exact: true })
  await expect(usage).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('cursor-before.png'), clip })

  await orcaPage.evaluate(() => {
    const store = window.__store!
    const cycle = {
      windowMinutes: 43_200,
      resetsAt: Date.now() + 86_400_000,
      resetDescription: null
    }
    store.setState({
      rateLimits: {
        ...store.getState().rateLimits,
        cursorAuthConfigured: true,
        cursor: {
          provider: 'cursor',
          status: 'ok',
          error: null,
          updatedAt: Date.now(),
          session: null,
          weekly: null,
          monthly: { ...cycle, usedPercent: 15 },
          buckets: [
            { ...cycle, name: 'Cursor Models', usedPercent: 6 },
            { ...cycle, name: 'Other models', usedPercent: 80 }
          ]
        }
      }
    })
  })
  await expect(usage).toContainText('Cursor Models 6% used')
  await expect(usage).toContainText('Other models 80% used')
  await orcaPage.screenshot({ path: testInfo.outputPath('cursor-detailed.png'), clip })
  await usage.click()
  await expect(orcaPage.getByRole('radio', { name: 'Detailed', exact: true })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('cursor-popover.png'), clip })
  await orcaPage.getByRole('radio', { name: 'Compact', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(usage).toContainText('80% used Other models')
  await expect(usage).not.toContainText('6%')
  await orcaPage.screenshot({ path: testInfo.outputPath('cursor-compact.png'), clip })

  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettingsOrThrow({ theme: 'light' })
  )
  await expect(orcaPage.locator('html')).not.toHaveClass(/dark/)
  await usage.click()
  await orcaPage.getByRole('radio', { name: 'Detailed', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(usage).toContainText('Cursor Models 6% used')
  await orcaPage.screenshot({ path: testInfo.outputPath('cursor-light.png'), clip })

  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
