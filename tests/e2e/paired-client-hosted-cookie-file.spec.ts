import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  openClientHostedFixturePage,
  selectPairedWorktreeGroup,
  waitForPairedWorktreeId,
  waitForRenderedClientWebview
} from './helpers/client-hosted-browser-fixture'

test('imports a cookie file into the paired desktop guest without touching the local jar', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(
      `<meta name="viewport" content="width=device-width,initial-scale=1"><h1 id="marker">Cookie import proof</h1><p>${req.headers.cookie?.includes('route_proof=imported') ? 'Imported cookie reached this page' : 'No imported cookie yet'}</p>`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('fixture address missing')
  }
  const url = `http://127.0.0.1:${address.port}/`
  const file = testInfo.outputPath('synthetic-cookies.json')
  writeFileSync(
    file,
    JSON.stringify([
      {
        domain: '127.0.0.1',
        path: '/',
        name: 'route_proof',
        value: 'imported',
        secure: false,
        httpOnly: false,
        expirationDate: 2147483647
      }
    ])
  )
  let host: Awaited<ReturnType<typeof launchHeadlessPairedRuntimeHost>> | null = null
  let client: PairedElectronClient | null = null
  try {
    host = await launchHeadlessPairedRuntimeHost()
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Cookie import proof'
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Cookie import client')
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
    await expect(
      client.page.getByRole('button', {
        name: 'Cookie import proof Close tab Cookie import proof',
        exact: true
      })
    ).toBeVisible({ timeout: 30_000 })
    const browser = await openClientHostedFixturePage(client, worktreeId, url)
    await waitForRenderedClientWebview(
      client.page,
      { urlPrefix: url, remotePageId: browser.remotePageId },
      'cookie fixture missing'
    )
    const gotIt = client.page.getByRole('button', { name: 'Got it', exact: true })
    await expect(gotIt.first()).toBeVisible({ timeout: 15_000 })
    for (let attempt = 0; attempt < 5 && (await gotIt.count()) > 0; attempt += 1) {
      await gotIt.first().click()
      await client.page.waitForTimeout(300)
    }
    await expect(gotIt).toHaveCount(0)
    const readText = () =>
      client!.app.evaluate(async ({ webContents }, url) => {
        const guest = webContents
          .getAllWebContents()
          .find((c) => c.getType() === 'webview' && c.getURL().startsWith(url))
        return guest?.executeJavaScript('document.body.innerText')
      }, url)
    await expect.poll(readText).toContain('No imported cookie yet')
    const localPartition = await client.page.evaluate(() =>
      window.api.browser.sessionResolvePartition({ profileId: 'default' })
    )
    expect(localPartition).toBeTruthy()
    await client.page.screenshot({ path: testInfo.outputPath('cookie-before.png') })
    // Only the native file chooser is replaced; the shipping preload and importer run unchanged.
    await client.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    const result = await client.page.evaluate(async (environmentId) => {
      const store = window.__store!
      store.setState({ browserSessionHostIdOverride: `runtime:${environmentId}` })
      return store.getState().importCookiesToProfile('default')
    }, client.environmentId)
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    await client.app.evaluate(async ({ webContents }, url) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(url))
      if (!guest) {
        throw new Error('guest missing')
      }
      await guest.reload()
    }, url)
    await expect.poll(readText).toContain('Imported cookie reached this page')
    const localCookies = await client.app.evaluate(
      async ({ session }, partition) =>
        session.fromPartition(partition!).cookies.get({ name: 'route_proof' }),
      localPartition
    )
    expect(localCookies).toHaveLength(0)
    await client.page.screenshot({ path: testInfo.outputPath('cookie-after.png') })
  } finally {
    await client?.dispose()
    await host?.dispose()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
