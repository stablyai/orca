import { expect, test } from './helpers/orca-app'
import { startClientHostedMarkerFixture } from './helpers/client-hosted-browser-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('local browser viewport matches client-hosted preset and reset behaviour', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const fixture = await startClientHostedMarkerFixture({
    created: 'Local viewport parity',
    moved: 'Another page',
    responsive: true
  })
  try {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await orcaPage.evaluate(
      ({ worktreeId, url }) => {
        window.__store?.getState().createBrowserTab(worktreeId, url, { activate: true })
      },
      { worktreeId, url: fixture.markerUrl }
    )
    const readWidth = () =>
      electronApp.evaluate(async ({ webContents }, origin) => {
        const guest = webContents
          .getAllWebContents()
          .find(
            (contents) => contents.getType() === 'webview' && contents.getURL().startsWith(origin)
          )
        return guest?.executeJavaScript('window.innerWidth')
      }, fixture.origin)
    await expect.poll(readWidth, { timeout: 30_000 }).toBeGreaterThan(375)
    const gotIt = orcaPage.getByRole('button', { name: 'Got it', exact: true })
    for (let attempt = 0; attempt < 5 && (await gotIt.count()) > 0; attempt += 1) {
      await gotIt
        .first()
        .click({ timeout: 2_000 })
        .catch(() => {})
    }
    await expect(gotIt).toHaveCount(0)
    const menu = orcaPage.getByRole('button', { name: 'Browser menu', exact: true })
    await menu.click()
    await orcaPage.getByRole('menuitem', { name: 'Viewport Size', exact: true }).hover()
    await orcaPage.getByRole('menuitemradio', { name: 'Mobile M', exact: false }).click()
    await expect.poll(readWidth).toBe(375)
    await orcaPage.keyboard.press('Escape')
    await orcaPage.keyboard.press('Escape')
    await testInfo.attach('local-mobile-viewport', {
      body: await orcaPage.screenshot({ path: testInfo.outputPath('local-mobile-viewport.png') }),
      contentType: 'image/png'
    })
    await menu.click()
    await orcaPage.getByRole('menuitem', { name: 'Viewport Size', exact: true }).hover()
    await orcaPage.getByRole('menuitemradio', { name: 'Default', exact: true }).click()
    await expect.poll(readWidth).toBeGreaterThan(375)
  } finally {
    await fixture.close()
  }
})
