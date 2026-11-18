import { createServer, type Server } from 'node:http'
import { launchHeadlessPairedRuntimeHost } from '../../remote/paired-runtime/client-hosts/headless-paired-runtime-host'
import { focusMaterializedRemoteBrowserPane } from './materialized-remote-browser-pane'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from '../../remote/paired-runtime/client-hosts/paired-electron-client'
import { waitForPairedClientWorktree } from '../../remote/paired-runtime/client-hosts/paired-client-host-session'

async function startPageServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>${request.url}</title><h1>${request.url}</h1>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('page server has no port')
  }
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

test("a server page's Back and Forward follow its history", async ({ testRepoPath }, testInfo) => {
  // Boots a headless host and a paired client before streaming the page.
  test.setTimeout(300_000)
  const { server, origin } = await startPageServer()
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Remote browser history')
    const page = client.page
    const worktree = `id:${await waitForPairedClientWorktree(page)}`
    const created = (
      await host.client.call<{ browserPageId: string }>('browser.tabCreate', {
        worktree,
        url: `${origin}/first`,
        placement: { kind: 'server' }
      })
    ).result
    await focusMaterializedRemoteBrowserPane(page, {
      environmentId: client.environmentId,
      remotePageId: created.browserPageId,
      worktreeId: worktree.slice('id:'.length)
    })
    await expect(page.getByTestId('remote-browser-frame').first()).toBeVisible({ timeout: 60_000 })
    const back = page.getByRole('button', { name: 'Back', exact: true })
    const forward = page.getByRole('button', { name: 'Forward', exact: true })
    await expect(back).toBeDisabled({ timeout: 30_000 })
    await expect(forward).toBeDisabled()

    await host.client.call('browser.goto', {
      worktree,
      page: created.browserPageId,
      url: `${origin}/second`
    })
    await expect(back).toBeEnabled({ timeout: 30_000 })
    await expect(forward).toBeDisabled()

    await back.click()
    await expect(forward).toBeEnabled({ timeout: 30_000 })
    await expect(back).toBeDisabled()
  } finally {
    await client?.dispose()
    await host.dispose()
    server.close()
  }
})
