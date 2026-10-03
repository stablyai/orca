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

test('annotates an element of a client-hosted browser page', async ({ testRepoPath }, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await startClientHostedMarkerFixture({
    created: 'Client-hosted annotation',
    moved: 'Another page'
  })
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Browser annotate'
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Browser annotate client')
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
    const browser = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
    const target = { urlPrefix: fixture.origin, remotePageId: browser.remotePageId }
    await waitForRenderedClientWebview(client.page, target, 'client-hosted fixture never rendered')
    // Why a loop: first-run tours can stack, and one left open covers the guest.
    const gotIt = client.page.getByRole('button', { name: 'Got it', exact: true })
    await expect(gotIt.first()).toBeVisible()
    for (let attempt = 0; attempt < 5 && (await gotIt.count()) > 0; attempt += 1) {
      await gotIt
        .first()
        .click({ timeout: 5_000 })
        .catch(() => {})
      await client.page.waitForTimeout(300)
    }
    await expect(gotIt).toHaveCount(0)

    const annotate = client.page.getByRole('button', { name: 'Annotate page element', exact: true })
    await expect(client.page.getByRole('button', { name: 'Grab page element' })).toBeEnabled()
    await expect(annotate).toBeEnabled()
    await annotate.click()

    // Why dispatched in the guest: native input does not reach a hidden test window, and the
    // picker's hover/click listeners on its overlay host are what a real click drives.
    await expect
      .poll(
        () =>
          client!.app.evaluate(async ({ webContents }, origin) => {
            const guest = webContents
              .getAllWebContents()
              .find(
                (contents) =>
                  contents.getType() === 'webview' && contents.getURL().startsWith(origin)
              )
            if (!guest) {
              return 'no-guest'
            }
            return guest.executeJavaScript(`(() => {
              const host = window.__orcaGrab && window.__orcaGrab.host
              if (!host) return 'not-armed'
              const r = document.getElementById('marker').getBoundingClientRect()
              const init = { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + r.height / 2 }
              host.dispatchEvent(new MouseEvent('mousemove', init))
              // The overlay commits the hovered element on the next animation frame.
              if (!window.__orcaGrab.getCurrentElement()) return 'no-hover'
              host.dispatchEvent(new MouseEvent('click', init))
              return 'clicked'
            })()`)
          }, fixture.origin),
        { timeout: 15_000 }
      )
      .toBe('clicked')

    const comment = client.page.getByPlaceholder('Describe what the agent should change here...')
    await expect(comment).toBeVisible({ timeout: 15_000 })
    await testInfo.attach('client-hosted-annotation-card', {
      body: await client.page.screenshot({ path: testInfo.outputPath('annotation-card.png') }),
      contentType: 'image/png'
    })
    await comment.fill('Make the heading larger')
    await client.page.getByRole('button', { name: /^Add(?! project)/ }).click()

    await expect(client.page.getByText('Make the heading larger')).toBeVisible()
    await expect(annotate).toContainText('1')
    await testInfo.attach('client-hosted-annotation-tray', {
      body: await client.page.screenshot({ path: testInfo.outputPath('annotation-tray.png') }),
      contentType: 'image/png'
    })
  } finally {
    await client?.dispose()
    await host.dispose()
    await fixture.close()
  }
})
