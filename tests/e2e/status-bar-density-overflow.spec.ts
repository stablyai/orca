import type { ProviderRateLimits } from '../../src/shared/rate-limit-types'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('ten usage providers survive a narrow viewport and expand again', async ({
  orcaPage: page
}, testInfo) => {
  const densityErrors: string[] = []
  const captureDensityError = (message: string): void => {
    if (/Maximum update depth|Minified React error #185/.test(message)) {
      densityErrors.push(message)
    }
  }
  page.on('pageerror', (error) => captureDensityError(error.message))
  page.on('console', (message) => captureDensityError(message.text()))

  await page.setViewportSize({ width: 1800, height: 800 })
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('store unavailable')
    }
    const limits = (provider: ProviderRateLimits['provider']): ProviderRateLimits => ({
      provider,
      session: { usedPercent: 25, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      status: 'ok',
      updatedAt: Date.now(),
      error: null
    })
    store.setState({
      statusBarVisible: true,
      statusBarUsageMode: 'verbose',
      detectedAgentIds: null,
      statusBarItems: [
        'claude',
        'codex',
        'gemini',
        'antigravity',
        'opencode-go',
        'kimi',
        'minimax',
        'grok',
        'cursor',
        'zcode',
        'resource-usage',
        'ports',
        'ssh'
      ],
      statusBarCompactChangeNoticeDismissed: true,
      usagePercentageDisplayChangeNoticeDismissed: true,
      rateLimits: {
        ...store.getState().rateLimits,
        claude: limits('claude'),
        codex: limits('codex'),
        gemini: limits('gemini'),
        antigravity: limits('antigravity'),
        opencodeGo: limits('opencode-go'),
        kimi: limits('kimi'),
        minimax: limits('minimax'),
        grok: limits('grok'),
        cursor: limits('cursor'),
        zcode: limits('zcode')
      }
    })
  })

  const usage = page.getByRole('button', { name: 'Usage', exact: true })
  const collapsed = usage.locator('[data-usage-chip][data-usage-collapsed=true]')
  const overflow = usage.locator('[data-usage-more]')
  await expect(usage).toBeVisible()
  await expect(usage.locator('[data-usage-chip]')).toHaveCount(10)
  await expect(collapsed).toHaveCount(0)

  let badgeWidth = 0
  for (const width of [180, 600, 180, 1800]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(usage).toBeVisible()
    if (width === 180) {
      await expect(collapsed).toHaveCount(10)
      await expect(overflow).toBeVisible()
      await expect.poll(() => overflow.innerText()).toBe('+10')
      badgeWidth = await overflow.evaluate((element) => element.getBoundingClientRect().width)
    } else if (width === 600) {
      await expect(overflow).toBeVisible()
      await expect.poll(() => overflow.innerText()).toMatch(/^\+[1-9]$/)
      await expect
        .poll(() => overflow.evaluate((element) => element.getBoundingClientRect().width))
        .toBeCloseTo(badgeWidth)
    } else if (width === 1800) {
      await expect(collapsed).toHaveCount(0)
      await expect(overflow).toHaveCount(0)
    }
    expect(densityErrors).toEqual([])
    await testInfo.attach(`status-bar-${width}`, {
      body: await page.screenshot(),
      contentType: 'image/png'
    })
  }
})
