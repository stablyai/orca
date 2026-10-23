import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('temporary error recovery can be found and enabled in Chat settings', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    const settings = await window.api.settings.set({
      experimentalNativeChat: true,
      nativeChatAutoContinueOnTransientError: false
    })
    window.__store!.setState({ settings })
    window.__store!.getState().openSettingsPage()
  })
  const search = orcaPage.getByPlaceholder('Search settings')
  await expect(search).toBeVisible()
  await search.fill('capacity')
  await orcaPage.getByRole('button', { name: 'Chat', exact: true }).click()
  const setting = orcaPage.locator('#chat-transient-error-recovery')
  const toggle = setting.getByRole('switch', {
    name: 'Toggle automatic continuation after temporary errors'
  })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(setting).toContainText('up to 3 times after 10, 30 and 60 seconds')
  await setting.screenshot({
    path: testInfo.outputPath('recovery-disabled.png'),
    animations: 'disabled'
  })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await setting.screenshot({
    path: testInfo.outputPath('recovery-enabled.png'),
    animations: 'disabled'
  })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
})
