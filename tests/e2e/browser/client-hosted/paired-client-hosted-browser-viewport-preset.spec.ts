import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { launchHeadlessPairedRuntimeHost } from '../../remote/paired-runtime/client-hosts/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from '../../remote/paired-runtime/client-hosts/paired-electron-client'
import {
  openClientHostedFixturePage,
  selectPairedWorktreeGroup,
  startClientHostedMarkerFixture,
  waitForPairedWorktreeId,
  waitForRenderedClientWebview
} from './client-hosted-browser-fixture'

test('the ⋯ menu sizes a client-hosted page to a viewport preset and back', async ({
  testRepoPath
}, testInfo) => {
  // Boots a headless host and a paired client before the page renders.
  test.setTimeout(300_000)
  const fixture = await startClientHostedMarkerFixture({ created: 'Viewport', moved: 'Moved' })
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Browser viewport'
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Browser viewport client')
    const page = client.page
    const worktreeId = await waitForPairedWorktreeId(page, testRepoPath)
    await selectPairedWorktreeGroup(page, client.environmentId, worktreeId)
    const browser = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
    const target = { urlPrefix: fixture.origin, remotePageId: browser.remotePageId }
    await waitForRenderedClientWebview(page, target, 'client-hosted fixture never rendered')
    const tour = page.getByRole('dialog', {
      name: 'This page renders on your desktop',
      exact: true
    })
    await tour.getByRole('button', { name: 'Got it', exact: true }).click()

    const guestViewport = (): Promise<string | null> =>
      page.evaluate(async (remotePageId) => {
        const host = document.querySelector(
          `[data-browser-client-page-id="${CSS.escape(remotePageId)}"]`
        )
        const webview = host?.querySelector<Electron.WebviewTag>('webview')
        if (!webview) {
          return null
        }
        // Both the emulated screen and the box the guest paints in must match the preset.
        const screen: unknown = await webview.executeJavaScript(
          '`${screen.width}x${screen.height}`'
        )
        const box = webview.getBoundingClientRect()
        return `${String(screen)} ${Math.round(box.width)}x${Math.round(box.height)}`
      }, browser.remotePageId)
    const fullViewport = await guestViewport()
    expect(fullViewport).not.toBe('320x568 320x568')

    const menu = page.getByRole('button', { name: 'Browser menu', exact: true })
    await menu.click()
    await page.getByRole('menuitem', { name: 'Viewport Size' }).hover()
    await page.getByRole('menuitemradio', { name: 'Mobile S — 320 × 568' }).click()
    await expect.poll(guestViewport, { timeout: 15_000 }).toBe('320x568 320x568')
    await testInfo.attach('client-hosted-viewport-preset', {
      body: await page.screenshot({ path: testInfo.outputPath('viewport-preset.png') }),
      contentType: 'image/png'
    })

    // The address-bar chip puts the page back.
    await page.getByRole('button', { name: /Reset viewport size/ }).click()
    await expect.poll(guestViewport, { timeout: 15_000 }).toBe(fullViewport)
  } finally {
    await client?.dispose()
    await host.dispose()
    await fixture.close()
  }
})
