import { createServer, type Server } from 'node:http'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  focusMaterializedRemoteBrowserPane,
  waitForMaterializedRemoteBrowserPane
} from './helpers/materialized-remote-browser-pane'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { waitForPairedClientWorktree } from './helpers/paired-client-host-session'
import { readHostBrowserPageIds } from './helpers/host-session-tabs'

// #36804: a click on a target=_blank link in a streamed server page opens a new Orca tab.

async function startLinkServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (request.url === '/destination') {
      response.end('<!doctype html><title>Blank destination</title><h1>Destination</h1>')
      return
    }
    // The link fills the viewport so a click anywhere on the streamed frame lands on it.
    response.end(`<!doctype html><title>Link source</title>
      <style>html,body{margin:0;height:100%}a{display:block;height:100%;font:40px system-ui}</style>
      <a id="blank-link" href="/destination" target="_blank">Open destination</a>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('link server has no port')
  }
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

test('a target=_blank click in a streamed server page opens a new Orca tab', async ({
  testRepoPath
}, testInfo) => {
  // Boots a headless host and a paired client, then waits on two streamed tab opens.
  test.setTimeout(300_000)
  const { server, origin } = await startLinkServer()
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Remote browser blank link')
    const page = client.page
    const environmentId = client.environmentId

    const worktreeId = await waitForPairedClientWorktree(page)

    // Server-side calls carry no paired client, like an agent driving the page.
    const created = (
      await host.client.call<{ browserPageId: string }>('browser.tabCreate', {
        worktree: `id:${worktreeId}`,
        url: `${origin}/`
      })
    ).result
    await focusMaterializedRemoteBrowserPane(page, {
      environmentId,
      remotePageId: created.browserPageId,
      worktreeId
    })
    const remoteFrame = page.getByTestId('remote-browser-frame').first()
    const addressBar = page.locator('[data-orca-browser-address-bar="true"]:visible')
    await expect(remoteFrame).toBeVisible({ timeout: 60_000 })
    await expect(addressBar).toHaveValue(`${origin}/`, { timeout: 60_000 })

    const listPages = (): Promise<string[]> => readHostBrowserPageIds(host.client, testRepoPath)
    // The client lists the server's new tab, whether or not it moved to it.
    const waitForOpenedTab = async (before: string[]): Promise<void> => {
      await expect
        .poll(async () => (await listPages()).length, {
          timeout: 30_000,
          message: 'the server never opened the link as a tab'
        })
        .toBe(before.length + 1)
      const remotePageId = (await listPages()).find((id) => !before.includes(id))!
      await waitForMaterializedRemoteBrowserPane(page, { environmentId, remotePageId, worktreeId })
    }

    // A scripted click names no client, so the tab opens without moving anyone's view.
    let before = await listPages()
    await host.client.call('browser.eval', {
      worktree: `id:${worktreeId}`,
      page: created.browserPageId,
      expression: "document.getElementById('blank-link').click()"
    })
    await waitForOpenedTab(before)
    await expect(addressBar).toHaveValue(`${origin}/`)

    // The client that clicks gets the new tab in front, as a local page would.
    before = await listPages()
    await remoteFrame.click()
    await waitForOpenedTab(before)
    await expect(addressBar).toHaveValue(`${origin}/destination`)
  } finally {
    await client?.dispose()
    await host.dispose()
    server.close()
  }
})
