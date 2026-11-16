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

    // The markup hint also says "Got it" and can appear before the browser tour.
    const browserTour = client.page.getByRole('dialog', {
      name: 'This page renders on your desktop',
      exact: true
    })
    await browserTour.getByRole('button', { name: 'Got it', exact: true }).click()
    await expect(browserTour).toBeHidden()
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
    const undo = overlay.getByRole('button', { name: 'Undo', exact: true })
    await expect(undo).toBeEnabled()

    // A later stroke and a text label, then erase only the first stroke and the label.
    await client.page.mouse.move(bounds.x + 40, bounds.y + 140)
    await client.page.mouse.down()
    await client.page.mouse.move(bounds.x + 240, bounds.y + 140, { steps: 10 })
    await client.page.mouse.up()
    await overlay.getByRole('button', { name: 'Text', exact: true }).click()
    await client.page.mouse.click(bounds.x + 40, bounds.y + 200)
    await overlay.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('gy')
    await client.page.keyboard.press('Enter')
    const firstStroke = { x: 30, y: 50, width: 220, height: 20 }
    const laterStroke = { x: 30, y: 130, width: 220, height: 20 }
    const label = { x: 30, y: 190, width: 80, height: 40 }
    const hasInk = (region: typeof firstStroke): Promise<boolean> =>
      canvas.evaluate((element, rect) => {
        if (!(element instanceof HTMLCanvasElement)) {
          throw new Error('Markup overlay canvas is not a canvas element')
        }
        const scale = element.width / element.getBoundingClientRect().width
        const pixels = element
          .getContext('2d')
          ?.getImageData(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale)
        return pixels ? pixels.data.some((value, index) => index % 4 === 3 && value > 0) : false
      }, region)
    await expect.poll(() => hasInk(label)).toBe(true)

    await overlay.getByRole('button', { name: 'Eraser', exact: true }).click()
    await client.page.mouse.click(bounds.x + 140, bounds.y + 60)
    await client.page.mouse.click(bounds.x + 48, bounds.y + 216)
    await expect.poll(() => hasInk(firstStroke)).toBe(false)
    await expect.poll(() => hasInk(label)).toBe(false)
    expect(await hasInk(laterStroke)).toBe(true)
    await testInfo.attach('client-hosted-markup-erased', {
      body: await client.page.screenshot({ path: testInfo.outputPath('markup-erased.png') }),
      contentType: 'image/png'
    })
    await undo.click()
    await undo.click()
    await expect.poll(() => hasInk(firstStroke)).toBe(true)
    await expect.poll(() => hasInk(label)).toBe(true)
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
