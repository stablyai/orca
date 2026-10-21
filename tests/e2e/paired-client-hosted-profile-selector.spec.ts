import type {
  BrowserProfileCreateResult,
  BrowserTabListResult
} from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  openClientHostedFixturePage,
  selectPairedWorktreeGroup,
  startClientHostedMarkerFixture,
  waitForPairedWorktreeId,
  waitForRenderedClientWebview
} from './helpers/client-hosted-browser-fixture'

test('selects a host-owned profile through the client-hosted toolbar without mixing cookie jars', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const fixture = await startClientHostedMarkerFixture({
    created: 'Profile selection',
    moved: 'Profile selection moved'
  })
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  try {
    const { profile } = (
      await host.client.call<BrowserProfileCreateResult>('browser.profileCreate', {
        scope: 'isolated',
        label: 'Server-only profile'
      })
    ).result
    if (!profile) {
      throw new Error('fixture profile creation failed')
    }
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Profile selection'
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Profile selector client')
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
    // Profile switching is independent of first-run onboarding. Mark its tours
    // seen before mounting the page rather than racing an animated tooltip.
    await client.page.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('test store unavailable')
      }
      store.getState().markContextualToursSeen(['browser', 'client-hosted-browser'])
      store.getState().dismissContextualTour()
      window.localStorage.setItem('orca.browser.markup-draw-hint-seen', 'true')
    })
    const browser = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
    const target = { urlPrefix: fixture.origin, remotePageId: browser.remotePageId }
    await waitForRenderedClientWebview(client.page, target, 'profile fixture missing')
    const gotIt = client.page.getByRole('button', { name: 'Got it', exact: true })
    await expect(gotIt).toHaveCount(0)
    const oldGuestId = await client.app.evaluate(async ({ webContents }, origin) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(origin))
      if (!guest) {
        throw new Error('fixture guest missing')
      }
      await guest.session.cookies.set({ url: origin, name: 'profile-proof', value: 'old-profile' })
      return guest.id
    }, fixture.origin)
    await client.page.getByRole('button', { name: 'Browser menu', exact: true }).click()
    const choice = client.page.getByRole('menuitemradio', {
      name: 'Server-only profile',
      exact: true
    })
    await expect(choice).toBeVisible()
    await testInfo.attach('profile-menu', {
      body: await client.page.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath('profile-menu.png')
      }),
      contentType: 'image/png'
    })
    await choice.click()
    const dialog = client.page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    expect(
      await client.app.evaluate(({ webContents }, id) => {
        const guest = webContents.fromId(id)
        return !!guest && !guest.isDestroyed()
      }, oldGuestId)
    ).toBe(true)
    await testInfo.attach('profile-confirmation', {
      body: await client.page.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath('profile-confirmation.png')
      }),
      contentType: 'image/png'
    })
    await dialog.getByRole('button', { name: 'Switch', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => {
        const listing = (await host.client.call<BrowserTabListResult>('browser.tabList', {})).result
        return listing.tabs.find((tab) => tab.browserPageId === browser.remotePageId)
      })
      .toMatchObject({ profileId: profile.id })
    await waitForRenderedClientWebview(client.page, target, 'replacement guest missing')
    await expect
      .poll(() =>
        client!.app.evaluate(async ({ webContents }, origin) => {
          const guest = webContents
            .getAllWebContents()
            .find((c) => c.getType() === 'webview' && c.getURL().startsWith(origin))
          return guest
            ? {
                id: guest.id,
                cookies: await guest.session.cookies.get({ url: origin, name: 'profile-proof' })
              }
            : null
        }, fixture.origin)
      )
      .toMatchObject({ cookies: [] })
    await testInfo.attach('profile-switched', {
      body: await client.page.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath('profile-switched.png')
      }),
      contentType: 'image/png'
    })
  } finally {
    await client?.dispose()
    await host.dispose()
    await fixture.close()
  }
})
