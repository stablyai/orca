import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('tints status-bar usage chips by provider when enabled', async ({ orcaPage }, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const window5h = { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null }
    const snapshot = (provider: 'claude' | 'codex') => ({
      provider,
      session: window5h,
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok' as const
    })
    const state = store.getState()
    store.setState({
      rateLimits: { ...state.rateLimits, claude: snapshot('claude'), codex: snapshot('codex') },
      statusBarItems: Array.from(new Set([...state.statusBarItems, 'claude', 'codex']))
    })
  })

  const claudeChip = orcaPage.locator('[data-usage-chip="claude"]')
  await expect(claudeChip).toBeVisible()
  const tint = () =>
    claudeChip.evaluate((el) => (el instanceof HTMLElement ? el.style.backgroundColor : ''))
  await expect.poll(tint).toBe('')
  const bar = claudeChip.locator('xpath=ancestor::button[1]')
  const beforePath = testInfo.outputPath('provider-colors-before.png')
  await bar.screenshot({ path: beforePath })
  await testInfo.attach('provider-colors-before', { path: beforePath, contentType: 'image/png' })

  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettingsOrThrow({
      statusBarProviderColorsEnabled: true,
      statusBarProviderColors: { codex: '#ff00aa' }
    })
  })

  await expect.poll(tint).not.toBe('')
  await expect
    .poll(() =>
      orcaPage
        .locator('[data-usage-chip="codex"]')
        .evaluate((el) => (el instanceof HTMLElement ? el.style.backgroundColor : ''))
    )
    .toContain('255, 0, 170')
  const afterPath = testInfo.outputPath('provider-colors-after.png')
  await bar.screenshot({ path: afterPath })
  await testInfo.attach('provider-colors-after', { path: afterPath, contentType: 'image/png' })
})
