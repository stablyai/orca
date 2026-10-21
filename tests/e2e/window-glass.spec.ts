import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'

// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture arguments.
test('window glass preserves opaque text and responds to accessibility settings', async ({}, testInfo) => {
  const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  const seedPath = path.join(session.userDataDir, 'orca-data.json')
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'))
  seed.settings = {
    ...seed.settings,
    theme: 'dark',
    windowBackgroundBlur: true,
    windowGlassStyle: 'frosted',
    terminalBackgroundOpacity: 0.55
  }
  writeFileSync(seedPath, JSON.stringify(seed))
  const { app, page } = await session.launch()
  try {
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().settings?.windowBackgroundBlur))
      .toBe(true)
    const available = await page.evaluate(() => window.api.app.getWindowGlassAvailable?.() === true)
    if (!available) {
      await expect(page.locator('html')).not.toHaveAttribute('data-window-glass')
      return
    }
    await expect(page.locator('html')).toHaveAttribute('data-window-glass', 'frosted')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)'
    )
    await page.screenshot({ path: testInfo.outputPath('frosted.png'), omitBackground: true })
    await page.evaluate(() =>
      window.__store?.getState().updateSettings({ windowGlassStyle: 'liquid' })
    )
    await expect(page.locator('html')).toHaveAttribute('data-window-glass', 'liquid')
    expect(
      await page
        .locator('.titlebar')
        .first()
        .evaluate((element) => getComputedStyle(element).opacity)
    ).toBe('1')
    await page.screenshot({ path: testInfo.outputPath('liquid.png'), omitBackground: true })
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(
        (theme) =>
          window.__store?.getState().updateSettings({ theme, terminalBackgroundOpacity: 0 }),
        theme
      )
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(theme === 'dark')
      const alphas = await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.className = 'native-chat-appearance'
        document.body.appendChild(probe)
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        if (!context) {
          throw new Error('A canvas context is required for color-alpha validation')
        }
        try {
          return ['--chat-foreground', '--chat-foreground-strong', '--chat-foreground-faint'].map(
            (token) => {
              probe.style.color = `var(${token})`
              context.clearRect(0, 0, 1, 1)
              context.fillStyle = getComputedStyle(probe).color
              context.fillRect(0, 0, 1, 1)
              return context.getImageData(0, 0, 1, 1).data[3]
            }
          )
        } finally {
          probe.remove()
        }
      })
      expect(alphas).toEqual([255, 255, 255])
    }
    await page.emulateMedia({ forcedColors: 'active' })
    await expect(page.locator('html')).not.toHaveAttribute('data-window-glass')
    await page.emulateMedia({ forcedColors: 'none' })
    await expect(page.locator('html')).toHaveAttribute('data-window-glass', 'liquid')
    await page.evaluate(() =>
      window.__store?.getState().updateSettings({ windowBackgroundBlur: false })
    )
    await expect(page.locator('html')).not.toHaveAttribute('data-window-glass')
    await page.screenshot({ path: testInfo.outputPath('standard.png') })
  } finally {
    await session.dispose(app)
  }
})
