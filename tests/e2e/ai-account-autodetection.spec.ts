import { test, expect } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRestartSession } from './helpers/orca-restart'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'

// oxlint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring.
test('account autodetection can be disabled without losing account setup and survives restart', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const session = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OPENCODE_API_KEY: ''
  })
  const profile = getE2ECompletedOnboardingProfile()
  writeFileSync(
    path.join(session.userDataDir, 'orca-data.json'),
    JSON.stringify({
      ...profile,
      settings: { ...profile.settings, automaticallyDetectAiAccounts: false }
    })
  )
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const page = launched.page
    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'accounts', repoId: null })
      state?.openSettingsPage()
    })
    const toggle = page.getByRole('switch', { name: 'Automatically detect existing AI accounts' })
    await expect(toggle).not.toBeChecked()
    await expect(
      page
        .getByText('Automatic account detection is disabled. Terminal CLI logins are unaffected.')
        .first()
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Add Account', exact: true }).first()
    ).toBeVisible()
    expect(
      await launched.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
    await page.setViewportSize({ width: 1280, height: 960 })
    await page.screenshot({ animations: 'disabled' })
    const screenshotPath = testInfo.outputPath('accounts-detection-disabled.png')
    await page.screenshot({ path: screenshotPath, animations: 'disabled' })
    await testInfo.attach('accounts-detection-disabled', {
      path: screenshotPath,
      contentType: 'image/png'
    })
    await page.evaluate(() =>
      window.__store?.getState().setSettingsSearchQuery('automatically detect')
    )
    await expect(toggle).toBeVisible()
    await page.evaluate(() => window.__store?.getState().setSettingsSearchQuery(''))
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.api.settings.get()).automaticallyDetectAiAccounts)
      )
      .toBe(true)
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.api.settings.get()).automaticallyDetectAiAccounts)
      )
      .toBe(false)
    await session.close(launched.app)
    launched = null
    const relaunched = await session.launch()
    launched = relaunched
    await expect
      .poll(() =>
        relaunched.page.evaluate(
          async () => (await window.api.settings.get()).automaticallyDetectAiAccounts
        )
      )
      .toBe(false)
    await launched.page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'accounts', repoId: null })
      state?.openSettingsPage()
    })
    await expect(
      launched.page.getByRole('switch', { name: 'Automatically detect existing AI accounts' })
    ).not.toBeChecked()
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
  }
})
