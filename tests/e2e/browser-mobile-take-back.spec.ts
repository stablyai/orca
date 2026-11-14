import { parsePairingCode } from '../../src/shared/remote-runtime/pairing/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../src/shared/remote-runtime/pairing/paired-runtime-connection'
import { subscribeRemoteRuntimeTransport } from '../../src/shared/remote-runtime/requests/remote-runtime-subscription-transport'
import type { RemoteRuntimeTransportSubscription } from '../../src/shared/remote-runtime/requests/remote-runtime-subscription-contract'
import type { BrowserScreencastResult } from '../../src/shared/browser/runtime/runtime-browser-contracts'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

test('browser Take back releases its retained driver state', async ({ orcaPage }) => {
  // Pairing admission and first screencast setup can exceed the default test timeout on cold builds.
  test.setTimeout(180_000)
  let mobileSubscription: RemoteRuntimeTransportSubscription | null = null
  try {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const browserPageId = await orcaPage.evaluate((targetWorktreeId) => {
      const tab = window.__store!.getState().createBrowserTab(targetWorktreeId, 'about:blank', {
        title: 'Mobile driver test',
        activate: true
      })
      return tab.activePageId
    }, worktreeId)
    if (!browserPageId) {
      throw new Error('Browser page was not created')
    }

    const addressBar = orcaPage.locator('[data-orca-browser-address-bar="true"]:visible')
    await expect(addressBar).toBeVisible({ timeout: 15_000 })
    const offer = await orcaPage.evaluate(() =>
      window.api.mobile.getPairingQR({
        address: '127.0.0.1',
        connectionMode: 'local-only',
        rotate: true
      })
    )
    if (!offer.available) {
      throw new Error(`Mobile pairing unavailable: ${offer.reason ?? 'unknown'}`)
    }
    const pairing = parsePairingCode(offer.pairingUrl)
    if (!pairing) {
      throw new Error('Mobile pairing URL was invalid')
    }
    let resolveReady!: () => void
    let rejectReady!: (error: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    mobileSubscription = await subscribeRemoteRuntimeTransport<BrowserScreencastResult>(
      pairedRuntimeConnectionFromOffer(pairing),
      'browser.screencast',
      { page: browserPageId },
      60_000,
      {
        onResponse: (response) => {
          if (!response.ok) {
            rejectReady(new Error(`Browser screencast failed: ${JSON.stringify(response)}`))
          } else if (response.result.type === 'ready') {
            resolveReady()
          }
        },
        onError: rejectReady
      }
    )
    await ready
    await expect
      .poll(() =>
        orcaPage.evaluate(async (targetPageId) => {
          const drivers = await window.api.runtime.getBrowserDrivers()
          return drivers.find(({ browserPageId: id }) => id === targetPageId)?.driver ?? null
        }, browserPageId)
      )
      .toMatchObject({ kind: 'mobile' })
    await expect(addressBar).toBeDisabled()

    const overlay = orcaPage.locator('.mobile-browser-driver-banner')
    await expect(overlay).toBeVisible({ timeout: 15_000 })
    await overlay.getByRole('button').click()
    await expect(overlay).toBeHidden({ timeout: 15_000 })
    await expect
      .poll(() =>
        orcaPage.evaluate(async (targetPageId) => {
          const drivers = await window.api.runtime.getBrowserDrivers()
          return drivers.some(({ browserPageId: id }) => id === targetPageId)
        }, browserPageId)
      )
      .toBe(false)
    await expect(addressBar).toBeEnabled()
  } finally {
    mobileSubscription?.close()
  }
})
