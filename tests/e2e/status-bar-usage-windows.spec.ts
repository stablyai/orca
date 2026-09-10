import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('selects footer windows independently of percentage display and restores the choice', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1100, height: 800 })
  async function seedUsage() {
    await orcaPage.evaluate(() => {
      const store = window.__store!
      const windowOf = (usedPercent: number, windowMinutes: number) => ({
        usedPercent,
        windowMinutes,
        resetsAt: null,
        resetDescription: null
      })
      store.setState({
        statusBarVisible: true,
        statusBarItems: ['claude', 'codex'],
        detectedAgentIds: ['claude', 'codex'],
        rateLimits: {
          ...store.getState().rateLimits,
          claude: {
            provider: 'claude',
            session: windowOf(90, 300),
            weekly: windowOf(40, 10080),
            status: 'ok',
            error: null,
            updatedAt: Date.now()
          },
          codex: {
            provider: 'codex',
            session: windowOf(70, 300),
            weekly: windowOf(30, 10080),
            status: 'ok',
            error: null,
            updatedAt: Date.now()
          }
        }
      })
    })
  }
  await seedUsage()
  const footer = orcaPage.getByRole('button', { name: 'Usage', exact: true })
  for (const display of ['used', 'remaining'] as const) {
    for (const mode of ['verbose', 'compact'] as const) {
      await orcaPage.evaluate(
        ({ display, mode }) => {
          window.__store!.getState().setUsagePercentageDisplay(display)
          window.__store!.getState().setStatusBarUsageMode(mode)
        },
        { display, mode }
      )
      for (const [label, value] of [
        ['5-hour', 'session'],
        ['Weekly', 'weekly'],
        ['Both', 'both']
      ] as const) {
        await footer.click()
        const picker = orcaPage.getByRole('radiogroup', { name: 'Footer windows' })
        await picker.getByRole('radio', { name: label, exact: true }).click()
        await expect(picker.getByRole('radio', { name: label, exact: true })).toBeChecked()
        await orcaPage.keyboard.press('Escape')
        const sessionPercent = display === 'used' ? '90% used' : '10% left'
        const weeklyPercent = display === 'used' ? '40% used' : '60% left'
        if (value === 'weekly') {
          await expect(footer).toContainText(weeklyPercent)
          await expect(footer).not.toContainText(sessionPercent)
        } else {
          await expect(footer).toContainText(sessionPercent)
          const weeklyExpectation =
            value === 'both' && mode === 'verbose' ? expect(footer) : expect(footer).not
          await weeklyExpectation.toContainText(weeklyPercent)
        }
      }
    }
  }

  await orcaPage.evaluate(() => {
    window.__store!.getState().setStatusBarUsageMode('verbose')
    window.__store!.getState().setStatusBarUsageWindows('weekly')
  })
  await expect
    .poll(() => orcaPage.evaluate(async () => (await window.api.ui.get()).statusBarUsageWindows))
    .toBe('weekly')
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await seedUsage()
  await expect(footer).toContainText('60% left')
  await expect(footer).not.toContainText('10% left')

  for (const theme of ['light', 'dark'] as const) {
    await orcaPage.evaluate((theme) => window.__store!.getState().updateSettings({ theme }), theme)
    for (const windows of ['both', 'weekly'] as const) {
      await orcaPage.evaluate(
        (windows) => window.__store!.getState().setStatusBarUsageWindows(windows),
        windows
      )
      await footer.press('Enter')
      await expect(orcaPage.getByRole('radiogroup', { name: 'Footer windows' })).toBeVisible()
      await electronApp.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.invalidate()
        }
      })
      await orcaPage.screenshot({
        path: testInfo.outputPath(`${theme}-${windows}.png`),
        animations: 'disabled'
      })
      await testInfo.attach(`${theme}-${windows}`, {
        path: testInfo.outputPath(`${theme}-${windows}.png`),
        contentType: 'image/png'
      })
      await orcaPage.keyboard.press('Escape')
    }
  }
})
