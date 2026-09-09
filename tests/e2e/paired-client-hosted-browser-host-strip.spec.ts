/**
 * STA-4150: a page a paired client renders is invisible in the HOST's own app unless main pushes
 * a row for it. This drives the whole seam through two real Electron apps — client creates the
 * page, the host's rendered tab strip grows a row for it, and closing that row from the host
 * tears the page down on the client.
 *
 * Uses the headed-host topology deliberately: under `orca serve` there is no window to push to,
 * so a headless host proves nothing about this feature.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const PAGE_TITLE = 'host-strip-marker'

async function startPageFixture(): Promise<{ close(): Promise<void>; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    })
    response.end(
      `<!doctype html><html><head><title>${PAGE_TITLE}</title></head><body><h1 id="marker">${PAGE_TITLE}</h1></body></html>`
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    close: () => closeServer(server),
    url: `http://127.0.0.1:${port}/hosted`
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function findWorktreeIdByPath(page: Page, repoPath: string): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (path) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => worktree.path === path)?.id ?? null,
          repoPath
        ),
      { timeout: 60_000, message: `no worktree for ${repoPath}` }
    )
    .not.toBeNull()
  const worktreeId = await page.evaluate(
    (path) =>
      window.__store
        ?.getState()
        .allWorktrees()
        .find((worktree) => worktree.path === path)?.id ?? null,
    repoPath
  )
  if (!worktreeId) {
    throw new Error(`Worktree for ${repoPath} disappeared after discovery`)
  }
  return worktreeId
}

async function createClientHostedPage(page: Page, url: string): Promise<void> {
  await page.evaluate(async (pageUrl) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Paired client has no active worktree')
    }
    const groupId = state.activeGroupIdByWorktree[state.activeWorktreeId]
    if (!groupId) {
      throw new Error('Paired client has no active tab group')
    }
    state.setBrowserDefaultUrl(pageUrl)
    await state.openNewBrowserTabInActiveWorkspace(groupId)
  }, url)
}

async function findHostPageId(
  page: Page,
  worktreeId: string,
  url: string
): Promise<{ hostPageId: string; placementKind: string | null } | null> {
  return page.evaluate(
    ({ pageUrl, worktree }) => {
      const state = window.__store?.getState()
      for (const workspace of state?.browserTabsByWorktree[worktree] ?? []) {
        for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
          if (!browserPage.url.startsWith(pageUrl)) {
            continue
          }
          const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
          return {
            hostPageId: handle?.remotePageId ?? browserPage.id,
            placementKind: handle?.placement?.kind ?? null
          }
        }
      }
      return null
    },
    { pageUrl: url, worktree: worktreeId }
  )
}

async function readOwnedPageUrls(app: ElectronApplication, url: string): Promise<string[]> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .map((contents) => contents.getURL())
        .filter((candidate) => candidate.startsWith(prefix)),
    url
  )
}

test('shows a client-hosted page in the host tab strip and closes it from there', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const fixture = await startPageFixture()
  let client: PairedElectronClient | null = null
  try {
    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    client = await launchPairedElectronClient(offer, testInfo, 'STA-4150 host strip')

    const clientWorktreeId = await findWorktreeIdByPath(client.page, testRepoPath)
    await client.page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId: clientWorktreeId }
    )

    await createClientHostedPage(client.page, fixture.url)
    await expect
      .poll(() => findHostPageId(client!.page, clientWorktreeId, fixture.url), {
        timeout: 60_000,
        message: 'client never materialized the client-hosted page'
      })
      .not.toBeNull()
    const mirrored = await findHostPageId(client.page, clientWorktreeId, fixture.url)
    expect(mirrored?.placementKind).toBe('client')
    const hostPageId = mirrored!.hostPageId

    // The page really is on the client, not the host — otherwise a host row proves nothing new.
    expect(await readOwnedPageUrls(client.app, fixture.url)).toHaveLength(1)
    expect(await readOwnedPageUrls(electronApp, fixture.url)).toHaveLength(0)

    const hostRow = orcaPage.locator(
      `.terminal-tab-strip [data-client-hosted-browser-row-id="${hostPageId}"]`
    )
    await expect(hostRow).toBeVisible({ timeout: 60_000 })
    // Titles come from the client's metadata publish; a URL-only row would mean that never landed.
    await expect(hostRow).toContainText(PAGE_TITLE, { timeout: 60_000 })

    await hostRow.getByRole('button', { name: 'Close hosted page' }).click()

    await expect(hostRow).toHaveCount(0, { timeout: 60_000 })
    await expect
      .poll(() => readOwnedPageUrls(client!.app, fixture.url), {
        timeout: 60_000,
        message: 'closing from the host never tore the guest down on the client'
      })
      .toHaveLength(0)
    await expect
      .poll(() => findHostPageId(client!.page, clientWorktreeId, fixture.url), {
        timeout: 60_000,
        message: 'client kept a tab for a page the host closed'
      })
      .toBeNull()
  } finally {
    await client?.dispose()
    await fixture.close()
  }
})
