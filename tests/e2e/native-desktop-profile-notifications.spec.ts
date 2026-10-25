import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { peerNativeWindow } from './helpers/native-desktop-window'
import { waitForSessionReady } from './helpers/store'

async function observeProfileChanges(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.profileChangeCount = '0'
    window.api.browser.onSessionProfilesChanged(() => {
      const element = document.documentElement
      element.dataset.profileChangeCount = String(Number(element.dataset.profileChangeCount) + 1)
    })
  })
}

async function expectProfileChange(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Number(document.documentElement.dataset.profileChangeCount)))
    .toBeGreaterThan(0)
}

test('both native windows receive browser profile changes before and after peer reload', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(180_000)
  const peer = await peerNativeWindow(electronApp, orcaPage)
  const profiles: string[] = []
  try {
    await observeProfileChanges(orcaPage)
    await observeProfileChanges(peer)
    const first = await orcaPage.evaluate(() =>
      window.api.browser.sessionCreateProfile({ scope: 'isolated', label: 'Native peer profiles' })
    )
    if (!first) {
      throw new Error('Browser profile creation failed')
    }
    profiles.push(first.id)
    await expectProfileChange(orcaPage)
    await expectProfileChange(peer)

    await peer.reload()
    await peer.waitForFunction(() => Boolean(window.__store))
    await waitForSessionReady(peer)
    await observeProfileChanges(orcaPage)
    await observeProfileChanges(peer)
    const second = await orcaPage.evaluate(() =>
      window.api.browser.sessionCreateProfile({
        scope: 'isolated',
        label: 'Native reloaded profiles'
      })
    )
    if (!second) {
      throw new Error('Browser profile creation after reload failed')
    }
    profiles.push(second.id)
    await expectProfileChange(orcaPage)
    await expectProfileChange(peer)
    const resetLoaded = peer.waitForEvent('domcontentloaded')
    const peerWindow = await electronApp.browserWindow(peer)
    await peerWindow.evaluate((window) => window.webContents.send('runtime:notifierReset'))
    await resetLoaded
    await peer.waitForFunction(() => Boolean(window.__store))
    await waitForSessionReady(peer)
    const restored = await peer.evaluate(() => window.api.browser.sessionListProfiles())
    expect(restored.map((profile) => profile.id)).toEqual(expect.arrayContaining(profiles))
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  } finally {
    for (const profileId of profiles) {
      await orcaPage.evaluate(
        (id) => window.api.browser.sessionDeleteProfile({ profileId: id }),
        profileId
      )
    }
  }
})
