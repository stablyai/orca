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

test('draws and copies a screenshot from a client-hosted browser without replacing its guest', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await startClientHostedMarkerFixture({
    created: 'Client-hosted screenshot',
    moved: 'Another page'
  })
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Browser markup'
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Browser markup client')
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
    const browser = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
    const target = { urlPrefix: fixture.origin, remotePageId: browser.remotePageId }
    await waitForRenderedClientWebview(client.page, target, 'client-hosted fixture never rendered')

    await client.page.getByRole('button', { name: 'Got it', exact: true }).click()
    await testInfo.attach('client-hosted-toolbar', {
      body: await client.page.screenshot({ path: testInfo.outputPath('toolbar.png') }),
      contentType: 'image/png'
    })
    const draw = client.page.getByRole('button', { name: 'Draw on screenshot', exact: true })
    await expect(draw).toBeEnabled()
    await draw.click()
    const overlay = client.page.locator('[data-orca-markup-overlay]')
    await expect(overlay).toBeVisible()
    await expect(overlay.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/)
    const canvas = overlay.locator('canvas')
    const bounds = await canvas.boundingBox()
    if (!bounds) {
      throw new Error('Markup canvas has no bounds')
    }
    await client.page.mouse.move(bounds.x + 40, bounds.y + 60)
    await client.page.mouse.down()
    await client.page.mouse.move(bounds.x + 240, bounds.y + 60, { steps: 10 })
    await client.page.mouse.up()
    await expect(overlay.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled()
    await testInfo.attach('client-hosted-markup', {
      body: await client.page.screenshot({ path: testInfo.outputPath('markup.png') }),
      contentType: 'image/png'
    })
    await client.app.evaluate(({ clipboard }) => clipboard.clear())
    await overlay.getByRole('button', { name: 'Copy Markup', exact: true }).click()
    await expect(overlay).toHaveCount(0)
    expect(await client.app.evaluate(({ clipboard }) => clipboard.readImage().isEmpty())).toBe(
      false
    )
    await waitForRenderedClientWebview(client.page, target, 'guest was not restored after copying')

    await draw.click()
    await expect(overlay).toBeVisible()
    await overlay.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(overlay).toHaveCount(0)
    await expect(draw).toHaveAttribute('aria-pressed', 'false')
    await waitForRenderedClientWebview(
      client.page,
      target,
      'guest was not restored after canceling'
    )
  } finally {
    await client?.dispose()
    await host.dispose()
    await fixture.close()
  }
})
