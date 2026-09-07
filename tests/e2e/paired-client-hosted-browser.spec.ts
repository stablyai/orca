import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type BrowserFixture = {
  close(): Promise<void>
  clientUrl: string
  serverUrl: string
}

type MirroredBrowserPage = {
  localPageId: string
  placementKind: 'client' | 'server' | null
  remotePageId: string
  workspaceId: string
}

async function startBrowserFixture(): Promise<BrowserFixture> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const marker = url.pathname === '/server' ? 'server-hosted-marker' : 'client-hosted-marker'
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    })
    response.end(`<!doctype html><html><head><title>${marker}</title></head><body>
      <h1 id="marker">${marker}</h1>
      <a href="/next">next</a>
    </body></html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    close: () => closeServer(server),
    clientUrl: `${origin}/client`,
    serverUrl: `${origin}/server`
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function findPairedWorktreeId(page: Page, repoPath: string): Promise<string> {
  const worktreeId = await expect
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
      { timeout: 60_000, message: 'paired client never received the host worktree' }
    )
    .not.toBeNull()
    .then(() =>
      page.evaluate(
        (path) =>
          window.__store
            ?.getState()
            .allWorktrees()
            .find((worktree) => worktree.path === path)?.id ?? null,
        repoPath
      )
    )
  if (!worktreeId) {
    throw new Error('Paired worktree disappeared after discovery')
  }
  return worktreeId
}

async function selectPairedWorktree(
  page: Page,
  environmentId: string,
  worktreeId: string
): Promise<void> {
  await page.evaluate(
    ({ environmentId, worktreeId }) => {
      window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
    },
    { environmentId, worktreeId }
  )
}

async function createProductBrowserPage(page: Page, url: string): Promise<void> {
  await page.evaluate(async (url) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Paired client has no active worktree')
    }
    const groupId = state.activeGroupIdByWorktree[state.activeWorktreeId]
    if (!groupId) {
      throw new Error('Paired client has no active tab group')
    }
    state.setBrowserDefaultUrl(url)
    await state.openNewBrowserTabInActiveWorkspace(groupId)
  }, url)
}

async function findMirroredBrowserPage(
  page: Page,
  worktreeId: string,
  url: string
): Promise<MirroredBrowserPage | null> {
  return page.evaluate(
    ({ url, worktreeId }) => {
      const state = window.__store?.getState()
      for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
        for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
          if (!browserPage.url.startsWith(url)) {
            continue
          }
          const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
          return {
            localPageId: browserPage.id,
            placementKind: handle?.placement?.kind ?? null,
            remotePageId: handle?.remotePageId ?? browserPage.id,
            workspaceId: workspace.id
          }
        }
      }
      return null
    },
    { url, worktreeId }
  )
}

async function waitForMirroredBrowserPage(
  page: Page,
  worktreeId: string,
  url: string
): Promise<MirroredBrowserPage> {
  await expect
    .poll(() => findMirroredBrowserPage(page, worktreeId, url), {
      timeout: 20_000,
      message: `paired client never materialized ${url}`
    })
    .not.toBeNull()
  const mirrored = await findMirroredBrowserPage(page, worktreeId, url)
  if (!mirrored) {
    throw new Error(`Mirrored browser page disappeared for ${url}`)
  }
  return mirrored
}

async function focusMirroredBrowserPage(
  page: Page,
  worktreeId: string,
  browserPageId: string
): Promise<void> {
  await page.evaluate(
    ({ browserPageId, worktreeId }) => {
      window.__store?.getState().focusBrowserTabInWorktree(worktreeId, browserPageId, {
        surfacePane: true
      })
    },
    { browserPageId, worktreeId }
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

async function readClientWebviewMarker(page: Page, url: string): Promise<string | null> {
  return page.evaluate(async (prefix) => {
    for (const candidate of document.querySelectorAll('webview')) {
      const webview = candidate as Electron.WebviewTag
      try {
        if (webview.getURL().startsWith(prefix)) {
          return (await webview.executeJavaScript(
            'document.querySelector("#marker")?.textContent ?? null'
          )) as string | null
        }
      } catch {
        // The guest may still be attaching.
      }
    }
    return null
  }, url)
}

async function callBrowserSnapshot(
  page: Page,
  environmentId: string,
  worktreeId: string,
  browserPageId: string
): Promise<string> {
  return page.evaluate(
    async ({ browserPageId, environmentId, worktreeId }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'browser.snapshot',
        params: { page: browserPageId, worktree: `id:${worktreeId}` },
        timeoutMs: 15_000
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return (response.result as { snapshot: string }).snapshot
    },
    { browserPageId, environmentId, worktreeId }
  )
}

async function runClientHostedBrowserJourney(args: {
  hostApp: ElectronApplication
  offer: RuntimeDesktopPairingOffer
  repoPath: string
  testInfo: TestInfo
  topology: 'headed' | 'headless'
}): Promise<void> {
  const fixture = await startBrowserFixture()
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(
      args.offer,
      args.testInfo,
      `STA-4150 ${args.topology} client-hosted browser`
    )
    const worktreeId = await findPairedWorktreeId(client.page, args.repoPath)
    await selectPairedWorktree(client.page, client.environmentId, worktreeId)

    await createProductBrowserPage(client.page, fixture.clientUrl)
    const clientHostedPage = await waitForMirroredBrowserPage(
      client.page,
      worktreeId,
      fixture.clientUrl
    )
    expect(clientHostedPage.placementKind).toBe('client')
    await focusMirroredBrowserPage(client.page, worktreeId, clientHostedPage.localPageId)

    await expect
      .poll(() => readClientWebviewMarker(client!.page, fixture.clientUrl), {
        timeout: 60_000,
        message: 'client-hosted Electron guest never rendered the fixture'
      })
      .toBe('client-hosted-marker')
    expect(await readOwnedPageUrls(client.app, fixture.clientUrl)).toHaveLength(1)
    expect(await readOwnedPageUrls(args.hostApp, fixture.clientUrl)).toHaveLength(0)
    await expect(client.page.getByTestId('remote-browser-frame')).toHaveCount(0)
    expect(
      await callBrowserSnapshot(
        client.page,
        client.environmentId,
        worktreeId,
        clientHostedPage.remotePageId
      )
    ).toContain('client-hosted-marker')

    await client.page.evaluate(async () => {
      await window.__store?.getState().updateSettings({
        browserClientHostedRemoteEnabled: false
      })
    })
    expect(await readOwnedPageUrls(client.app, fixture.clientUrl)).toHaveLength(1)

    await createProductBrowserPage(client.page, fixture.serverUrl)
    const serverHostedPage = await waitForMirroredBrowserPage(
      client.page,
      worktreeId,
      fixture.serverUrl
    )
    expect(serverHostedPage.placementKind).not.toBe('client')
    await focusMirroredBrowserPage(client.page, worktreeId, serverHostedPage.localPageId)
    await expect(client.page.getByTestId('remote-browser-frame').first()).toBeVisible({
      timeout: 60_000
    })
    await expect
      .poll(() => readOwnedPageUrls(args.hostApp, fixture.serverUrl), {
        timeout: 60_000,
        message: 'server-hosted fallback never loaded on the paired runtime'
      })
      .toHaveLength(1)
    expect(await readOwnedPageUrls(client.app, fixture.serverUrl)).toHaveLength(0)
    expect(await readOwnedPageUrls(client.app, fixture.clientUrl)).toHaveLength(1)
  } finally {
    await client?.dispose()
    await fixture.close()
  }
}

test('hosts a paired browser on the viewing desktop and keeps the kill switch new-page-only', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  await runClientHostedBrowserJourney({
    hostApp: electronApp,
    offer,
    repoPath: testRepoPath,
    testInfo,
    topology: 'headed'
  })
})

test('hosts a paired browser from a headless server and preserves server fallback', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Client-hosted browser canary'
    })
    await runClientHostedBrowserJourney({
      hostApp: host.app,
      offer: host.offer,
      repoPath: testRepoPath,
      testInfo,
      topology: 'headless'
    })
  } finally {
    await host.dispose()
  }
})
