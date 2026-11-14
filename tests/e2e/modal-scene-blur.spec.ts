import { test, expect } from './helpers/orca-app'

test.use({ seedTestRepo: false, orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test.describe('onboarding scene blur', () => {
  test.use({ dismissOnboarding: false })

  test('onboarding render recovery stays within the viewport', async ({ orcaPage }, testInfo) => {
    await expect(orcaPage.locator('[data-onboarding-overlay]')).toBeVisible()
    await orcaPage.evaluate(async () => {
      const onboarding = await window.api.onboarding.get()
      Object.defineProperty(onboarding, 'lastCompletedStep', {
        get() {
          throw new Error('Injected onboarding render failure')
        }
      })
      window.dispatchEvent(new CustomEvent('orca:onboarding-reopened', { detail: onboarding }))
    })

    const crashReport = orcaPage.getByRole('dialog').filter({
      has: orcaPage.getByRole('heading', { name: 'Orca hit a recoverable UI error' })
    })
    await crashReport.getByRole('button', { name: 'Close', exact: true }).click()
    const recovery = orcaPage.getByRole('alert').filter({ hasText: 'Onboarding hit an error.' })
    const retry = recovery.getByRole('button', { name: 'Retry', exact: true })
    await expect(retry).toBeInViewport()
    await orcaPage.screenshot({ path: testInfo.outputPath('onboarding-render-recovery.png') })

    await orcaPage.evaluate(async () => {
      window.dispatchEvent(
        new CustomEvent('orca:onboarding-reopened', { detail: await window.api.onboarding.get() })
      )
    })
    await retry.click()
    await expect(recovery).toHaveCount(0)
    await expect(orcaPage.locator('[data-onboarding-overlay]')).toBeVisible()
    await expect(orcaPage.locator('.app-layout > :first-child')).toHaveCSS('filter', 'blur(2px)')
  })
})
