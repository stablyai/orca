import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { LOCAL_EXECUTION_HOST_ID } from '../../src/shared/execution-host'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

// The link is a dev-server URL, so a client-local fallback would silently load a *different
// machine's* server while looking successful.

const PANE_PATH = '/remote-pane'
const LINK_PATH = '/remote-link-target'
const LINK_MARKER = 'remote link target'

type LinkFixtureServer = {
  close: () => Promise<void>
  linkLoadCount: () => number
  linkUrl: string
  paneUrl: string
}

async function startLinkFixtureServer(): Promise<LinkFixtureServer> {
  let linkLoadCount = 0
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestPath = request.url ?? '/'
    if (requestPath.startsWith(LINK_PATH)) {
      linkLoadCount += 1
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8'
      })
      response.end(`<!doctype html><html><body><h1>${LINK_MARKER}</h1></body></html>`)
      return
    }
    if (requestPath.startsWith(PANE_PATH)) {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8'
      })
      // Why the viewport-filling anchor: the context menu reads the link with
      // elementFromPoint over the screencast, so covering the viewport keeps the test off
      // screencast coordinate mapping — any right-click lands on the link.
      response.end(
        `<!doctype html><html><body style="margin:0"><a href="${LINK_PATH}" style="position:fixed;inset:0;display:block;background:#fff;color:#000;font:24px sans-serif">open me</a></body></html>`
      )
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Keep-alive sockets from either browser would otherwise hold the close open.
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    linkLoadCount: () => linkLoadCount,
    linkUrl: `${origin}${LINK_PATH}`,
    paneUrl: `${origin}${PANE_PATH}`
  }
}

/** Asked over the host's own connection, not proxied through the client under test. */
async function readHostBrowserUrls(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string
): Promise<string[]> {
  const response = await host.client.call<{ tabs: { type: string; url?: string }[] }>(
    'session.tabs.list',
    { worktree: `id:${worktreeId}` },
    { timeoutMs: 15_000 }
  )
  return response.result.tabs.filter((tab) => tab.type === 'browser').map((tab) => tab.url ?? '')
}

/** A remote pane is a screencast image; a <webview> means the page really loaded on this machine. */
async function readLocalBrowserViewUrls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('webview')).map(
      (view) => (view as HTMLElement & { src?: string }).src || view.getAttribute('src') || ''
    )
  )
}

async function readRemotePaneUrls(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    const workspaces = state?.browserTabsByWorktree[worktreeId] ?? []
    return workspaces
      .flatMap((workspace) => state?.browserPagesByWorkspace[workspace.id] ?? [])
      .filter(
        (browserPage) => state?.remoteBrowserPageHandlesByPageId[browserPage.id]?.environmentId
      )
      .map((browserPage) => browserPage.url)
  }, worktreeId)
}

/** The client mirrors host browser tabs on its own; this finds the mirrored page for one URL. */
async function findMirroredPage(
  page: Page,
  worktreeId: string,
  url: string
): Promise<{ handleEnvironmentId: string | null; pageId: string } | null> {
  return page.evaluate(
    ({ url, worktreeId }) => {
      const state = window.__store?.getState()
      for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
        for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
          if (browserPage.url.startsWith(url)) {
            return {
              handleEnvironmentId:
                state?.remoteBrowserPageHandlesByPageId[browserPage.id]?.environmentId ?? null,
              pageId: browserPage.id
            }
          }
        }
      }
      return null
    },
    { url, worktreeId }
  )
}

async function focusMirroredPage(page: Page, worktreeId: string, pageId: string): Promise<void> {
  await page.evaluate(
    ({ pageId, worktreeId }) => {
      window.__store?.getState().focusBrowserTabInWorktree(worktreeId, pageId, {
        surfacePane: true
      })
    },
    { pageId, worktreeId }
  )
}

type LinkOpenOutcome = 'opened on this machine' | 'pending' | 'refused'

async function readLinkOpenOutcome(page: Page, linkUrl: string): Promise<LinkOpenOutcome> {
  if ((await readLocalBrowserViewUrls(page)).some((url) => url.startsWith(linkUrl))) {
    return 'opened on this machine'
  }
  const notice = page.getByTestId('remote-browser-stream-error')
  const text = (await notice.count()) > 0 ? ((await notice.first().textContent()) ?? '') : ''
  return text.includes('Unable to open URL.') ? 'refused' : 'pending'
}

async function openLinkFromRemotePaneContextMenu(page: Page): Promise<void> {
  const remoteFrame = page.locator('[data-testid="remote-browser-frame"]:visible').first()
  await expect(remoteFrame).toBeVisible({ timeout: 60_000 })
  await remoteFrame.click({ button: 'right', position: { x: 60, y: 60 }, force: true })
  await expect(page.getByTestId('remote-browser-context-menu')).toBeVisible({ timeout: 30_000 })
  // The item only renders once the remote hit-test resolves an anchor, so this wait is the
  // wait for the link lookup itself.
  const openInOrca = page.getByRole('menuitem', { name: 'Open Link In Orca Browser' })
  await expect(openInOrca).toBeVisible({ timeout: 30_000 })
  await openInOrca.click()
}

test('opens a remote pane link on the pane runtime and refuses to fall back to the client', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await startLinkFixtureServer()
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Remote browser link routing')
    const page = client.page
    const environmentId = client.environmentId

    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees().length ?? 0), {
        timeout: 60_000,
        message: 'paired client never saw a host worktree'
      })
      .toBeGreaterThan(0)
    const worktreeId = await page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? null
    )
    if (!worktreeId) {
      throw new Error('paired client did not receive the host worktree')
    }

    // The workspace runs on the paired runtime, the way it does when the user picks that host.
    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId, worktreeId }
    )

    // The host opens the page on itself: this is the "remote server" whose links must stay remote.
    await host.client.call(
      'browser.tabCreate',
      { worktree: `id:${worktreeId}`, url: fixture.paneUrl, activate: true },
      { timeoutMs: 30_000 }
    )
    await expect
      .poll(() => findMirroredPage(page, worktreeId, fixture.paneUrl), {
        timeout: 60_000,
        message: 'the client never mirrored the host browser page'
      })
      .not.toBeNull()
    const pane = await findMirroredPage(page, worktreeId, fixture.paneUrl)
    if (!pane) {
      throw new Error('mirrored host browser page disappeared')
    }
    expect(pane.handleEnvironmentId).toBe(environmentId)
    await focusMirroredPage(page, worktreeId, pane.pageId)
    const paneCountBeforeOpen = await page.getByTestId('remote-browser-pane').count()

    // Act 1: the healthy path must land on the runtime, end to end.
    await openLinkFromRemotePaneContextMenu(page)

    await expect
      .poll(
        async () =>
          (await readHostBrowserUrls(host, worktreeId)).filter((url) =>
            url.startsWith(fixture.linkUrl)
          ).length,
        { timeout: 60_000, message: 'the link never opened as a browser tab on the host runtime' }
      )
      .toBe(1)
    // The host's browser really fetched it; a tab record alone would not prove a load.
    expect(fixture.linkLoadCount()).toBeGreaterThan(0)
    // One more remote pane, and still nothing rendered by this machine's own browser.
    await expect(page.getByTestId('remote-browser-pane')).toHaveCount(paneCountBeforeOpen + 1, {
      timeout: 60_000
    })
    expect(await readRemotePaneUrls(page, worktreeId)).toContainEqual(
      expect.stringContaining(fixture.linkUrl)
    )
    expect(await readLocalBrowserViewUrls(page)).toHaveLength(0)

    // Drop every tab except the pane's, so the second act drives the pane it started with.
    await page.evaluate(
      ({ paneUrl, worktreeId }) => {
        const state = window.__store?.getState()
        for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
          const pages = state?.browserPagesByWorkspace[workspace.id] ?? []
          if (!pages.some((browserPage) => browserPage.url.startsWith(paneUrl))) {
            state?.closeBrowserTab(workspace.id)
          }
        }
      },
      { paneUrl: fixture.paneUrl, worktreeId }
    )
    await expect(page.getByTestId('remote-browser-pane')).toHaveCount(paneCountBeforeOpen, {
      timeout: 60_000
    })

    // Act 2: the user moves this workspace onto their own machine while the runtime's page is
    // still on screen. Opening the link must fail in the pane, not load the runtime's dev server
    // here — the client has no business serving a page for a workspace it does not run.
    await page.evaluate(
      ({ localHostId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, localHostId)
      },
      { localHostId: LOCAL_EXECUTION_HOST_ID, worktreeId }
    )
    await focusMirroredPage(page, worktreeId, pane.pageId)
    const hostUrlsBefore = await readHostBrowserUrls(host, worktreeId)
    const linkLoadsBefore = fixture.linkLoadCount()

    await openLinkFromRemotePaneContextMenu(page)

    // Wait for the click to produce an outcome — refusal or a local page — so the assertion below
    // reports which one happened instead of racing past a fallback that lands a moment later.
    await expect
      .poll(() => readLinkOpenOutcome(page, fixture.linkUrl), {
        timeout: 30_000,
        message: 'the link open produced neither a refusal nor a page'
      })
      .not.toBe('pending')
    expect(await readLinkOpenOutcome(page, fixture.linkUrl)).toBe('refused')

    // The workspace must still be the local one, or the refusal above proved nothing.
    expect(
      await page.evaluate(() => window.__store?.getState().activeWorkspaceExecutionHostId ?? null)
    ).toBe(LOCAL_EXECUTION_HOST_ID)
    // Nothing rendered here, nothing new on the host, and nobody fetched the link anywhere.
    expect(await readLocalBrowserViewUrls(page)).toHaveLength(0)
    expect(await readHostBrowserUrls(host, worktreeId)).toEqual(hostUrlsBefore)
    expect(fixture.linkLoadCount()).toBe(linkLoadsBefore)
  } finally {
    if (client) {
      await client.dispose()
    }
    await host.dispose()
    await fixture.close()
  }
})
