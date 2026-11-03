import { createServer, type Server } from 'node:http'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import { focusMaterializedRemoteBrowserPane } from './helpers/materialized-remote-browser-pane'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { waitForPairedClientWorktree } from './helpers/paired-client-host-session'

// STA-10228: a server page that changes its address in place updates the paired client's address bar.

async function startPageServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>In-page</title><a id="hash-link" href="#linked">Jump</a>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('page server has no port')
  }
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

test('history updates and hash links in a server page reach the paired address bar', async ({
  testRepoPath
}, testInfo) => {
  // Boots a headless host and a paired client before streaming the page.
  test.setTimeout(300_000)
  const { server, origin } = await startPageServer()
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Remote browser in-page URL')
    const page = client.page
    const worktreeId = await waitForPairedClientWorktree(page)
    const worktree = `id:${worktreeId}`

    const created = (
      await host.client.call<{ browserPageId: string }>('browser.tabCreate', {
        worktree,
        url: `${origin}/`
      })
    ).result
    await focusMaterializedRemoteBrowserPane(page, {
      environmentId: client.environmentId,
      remotePageId: created.browserPageId,
      worktreeId
    })
    const addressBar = page.locator('[data-orca-browser-address-bar="true"]:visible')
    await expect(page.getByTestId('remote-browser-frame').first()).toBeVisible({ timeout: 60_000 })
    await expect(addressBar).toHaveValue(`${origin}/`, { timeout: 60_000 })

    // Scripted from the host so no client input triggers the pane's own address read.
    const runInPage = (expression: string): Promise<unknown> =>
      host.client.call('browser.eval', {
        worktree,
        page: created.browserPageId,
        expression
      })

    await runInPage("history.pushState(null, '', '/pushed')")
    await expect(addressBar).toHaveValue(`${origin}/pushed`, { timeout: 30_000 })

    await runInPage("document.getElementById('hash-link').click()")
    await expect(addressBar).toHaveValue(`${origin}/pushed#linked`, { timeout: 30_000 })

    // A full navigation keeps publishing alongside the in-page path.
    await runInPage("location.href = '/full'")
    await expect(addressBar).toHaveValue(`${origin}/full`, { timeout: 30_000 })
  } finally {
    await client?.dispose()
    await host.dispose()
    server.close()
  }
})
