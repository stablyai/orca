import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { expect, test } from './helpers/orca-app'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import {
  callPairedRuntime,
  waitForPairedClientWorktree
} from './helpers/paired-client-host-session'

// #41682: a tab the server's own agent opens goes on a paired "This device" desktop, else it streams.

async function startPageServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>${request.url}</title><h1>${request.url}</h1>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('page server has no port')
  }
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function rendersUrl(app: ElectronApplication, url: string): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().some((c) => c.getURL() === url),
    url
  )
}

async function sessionRowPlacement(
  page: Page,
  environmentId: string,
  worktreeId: string,
  browserPageId: string
): Promise<string | null> {
  const listed = await callPairedRuntime<{
    tabs: { browserPageId?: string; placement?: { kind: string } }[]
  }>(page, environmentId, 'session.tabs.list', { worktree: `id:${worktreeId}` })
  const row = listed.tabs.find((tab) => tab.browserPageId === browserPageId)
  return row ? (row.placement?.kind ?? 'server') : null
}

test('a server agent tab opens on a This-device desktop and streams for a streamed one', async ({
  testRepoPath
}, testInfo) => {
  // Boots a headless host and a paired desktop, then waits on two real page loads.
  test.setTimeout(300_000)
  const { server, origin } = await startPageServer()
  const host = await launchHeadlessPairedRuntimeHost()
  let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Server agent tab placement')
    const { page, app, environmentId } = client
    const worktreeId = await waitForPairedClientWorktree(page)
    // Server-side calls carry no paired client, like an agent's `orca tab create`.
    const agentCreate = async (url: string): Promise<string> =>
      (
        await host.client.call<{ browserPageId: string }>(
          'browser.tabCreate',
          { worktree: `id:${worktreeId}`, url },
          { timeoutMs: 60_000 }
        )
      ).result.browserPageId

    const onDesktop = await agentCreate(`${origin}/this-device`)
    await expect
      .poll(() => rendersUrl(app, `${origin}/this-device`), { timeout: 60_000 })
      .toBe(true)
    expect(await rendersUrl(host.app, `${origin}/this-device`)).toBe(false)
    await expect
      .poll(() => sessionRowPlacement(page, environmentId, worktreeId, onDesktop))
      .toBe('client')

    // The desktop is asked again even while it hosts, so switching to streamed applies at once.
    await page.evaluate(() =>
      window.__store?.getState().updateSettings({ browserClientHostedRemoteEnabled: false })
    )
    const streamed = await agentCreate(`${origin}/streamed`)
    await expect
      .poll(() => rendersUrl(host.app, `${origin}/streamed`), { timeout: 60_000 })
      .toBe(true)
    expect(await rendersUrl(app, `${origin}/streamed`)).toBe(false)
    await expect
      .poll(() => sessionRowPlacement(page, environmentId, worktreeId, streamed))
      .toBe('server')
  } finally {
    await client?.dispose()
    await host.dispose()
    server.close()
  }
})
