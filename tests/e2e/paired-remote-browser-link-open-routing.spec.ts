import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { LOCAL_EXECUTION_HOST_ID } from '../../src/shared/execution-host'
import { readOwnedPageUrls } from './helpers/client-hosted-browser-observer'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import { readHostBrowserPageUrls } from './helpers/host-session-tabs'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

// Remote pane dev-server links must stay on its owning runtime; assert host records because a local fallback could load a different machine’s server.

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
      // Fill the viewport with the anchor so every screencast right-click tests routing rather than coordinate mapping.
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

// Read the host through its own CLI socket; without client-host capability its projection contains only server-placed pages.
async function readHostServerPlacedBrowserUrls(
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

/** Under server placement the client renders nothing itself, so any <webview> is a local fallback. */
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
): Promise<{
  handleEnvironmentId: string | null
  pageId: string
} | null> {
  return page.evaluate(
    ({ url, worktreeId }) => {
      const state = window.__store?.getState()
      for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
        for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
          if (browserPage.url.startsWith(url)) {
            const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
            return {
              handleEnvironmentId: handle?.environmentId ?? null,
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

/** Every browser row this client holds for the worktree, as the store sees it. */
async function readMirroredRows(
  page: Page,
  worktreeId: string
): Promise<{ environmentId: string | null; staged: boolean; title: string; url: string }[]> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    return (state?.browserTabsByWorktree[worktreeId] ?? []).flatMap((workspace) =>
      (state?.browserPagesByWorkspace[workspace.id] ?? []).map((browserPage) => {
        const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
        return {
          environmentId: handle?.environmentId ?? null,
          staged: handle?.staged === true,
          title: browserPage.title,
          url: browserPage.url
        }
      })
    )
  }, worktreeId)
}

// Read the client’s own host projection beside its store to distinguish lost apply from lost publication.
async function readHostRowsThroughClient(
  page: Page,
  environmentId: string,
  worktreeId: string
): Promise<string[]> {
  return page.evaluate(
    async ({ environmentId, worktreeId }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'session.tabs.list',
        params: { worktree: `id:${worktreeId}` },
        timeoutMs: 15_000
      })
      if (!response.ok) {
        return ['<host tab inventory unavailable>']
      }
      const result = response.result
      if (
        !result ||
        typeof result !== 'object' ||
        !('tabs' in result) ||
        !Array.isArray(result.tabs)
      ) {
        return ['<host tab inventory unavailable>']
      }
      const tabs = result.tabs.filter(
        (tab): tab is { type: string; url?: string } =>
          typeof tab === 'object' &&
          tab !== null &&
          'type' in tab &&
          typeof tab.type === 'string' &&
          (!('url' in tab) || typeof tab.url === 'string')
      )
      return tabs.filter((tab) => tab.type === 'browser').map((tab) => tab.url ?? '')
    },
    { environmentId, worktreeId }
  )
}

// Wait for the background mirrored row before checking panes; only surfacing the workspace mounts its runtime pane.
async function waitForMirroredLinkPageId(
  page: Page,
  environmentId: string,
  hostRowsAtOpen: readonly string[],
  worktreeId: string,
  url: string
): Promise<string> {
  try {
    await expect
      .poll(() => findMirroredPage(page, worktreeId, url), { timeout: 60_000 })
      .not.toBeNull()
  } catch {
    // Compare store and per-client host projection to distinguish lost apply, projection or navigation; use the happy-path host-socket sample because rereading it can hang.
    const clientRows = await readMirroredRows(page, worktreeId)
    const hostRowsViaClient = await readHostRowsThroughClient(page, environmentId, worktreeId)
    throw new Error(
      `the client never mirrored the link the host opened; client rows: ${JSON.stringify(
        clientRows
      )}; host rows at open: ${JSON.stringify(
        hostRowsAtOpen
      )}; host rows through client: ${JSON.stringify(hostRowsViaClient)}`
    )
  }
  const opened = await findMirroredPage(page, worktreeId, url)
  if (!opened) {
    throw new Error('mirrored link page disappeared')
  }
  return opened.pageId
}

/** Placement is a user setting whose default has already flipped once, so every act pins its own. */
async function pinClientHostedPlacement(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (enabled) => {
    await window.__store?.getState().updateSettings({ browserClientHostedRemoteEnabled: enabled })
  }, enabled)
  expect(
    await page.evaluate(
      () => window.__store?.getState().settings?.browserClientHostedRemoteEnabled ?? null
    ),
    'the placement setting this act is written for did not take'
  ).toBe(enabled)
}

/** Leaves the workspace holding only the screencast pane the next act right-clicks. */
async function closeBrowserTabsExceptPane(
  page: Page,
  worktreeId: string,
  paneUrl: string
): Promise<void> {
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
    { paneUrl, worktreeId }
  )
}

type LinkOpenOutcome = 'opened on this machine' | 'pending' | 'refused'

/** The previous act's guest is settled away before this runs, so any page here is the fallback. */
async function readLinkOpenOutcome(
  client: PairedElectronClient,
  linkUrl: string
): Promise<LinkOpenOutcome> {
  if ((await readOwnedPageUrls(client.app, linkUrl)).length > 0) {
    return 'opened on this machine'
  }
  const notice = client.page.getByTestId('remote-browser-stream-error')
  const text = (await notice.count()) > 0 ? ((await notice.first().textContent()) ?? '') : ''
  return text.includes('Unable to open URL.') ? 'refused' : 'pending'
}

async function openLinkFromRemotePaneContextMenu(page: Page): Promise<void> {
  const remoteFrame = page.locator('[data-testid="remote-browser-frame"]:visible').first()
  await expect(remoteFrame).toBeVisible({ timeout: 60_000 })
  await remoteFrame.click({ button: 'right', position: { x: 60, y: 60 }, force: true })
  await expect(page.getByTestId('remote-browser-context-menu')).toBeVisible({ timeout: 30_000 })
  // The menu appears only after remote anchor hit-testing resolves.
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

    const worktreeSelector = `id:${worktreeId}`

    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId, worktreeId }
    )
    // Wait for the empty workspace’s auto-created terminal before refocusing the pane so late creation cannot hide it.
    await expect
      .poll(
        () =>
          page.evaluate(
            (worktreeId) =>
              (window.__store?.getState().tabsByWorktree[worktreeId]?.length ?? 0) > 0,
            worktreeId
          ),
        { timeout: 60_000, message: 'the activated workspace never seeded its first terminal' }
      )
      .toBe(true)

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

    // With server placement, require a streamed runtime page and no local render.
    await pinClientHostedPlacement(page, false)
    await openLinkFromRemotePaneContextMenu(page)

    await expect
      .poll(
        async () =>
          (await readHostServerPlacedBrowserUrls(host, worktreeId)).filter((url) =>
            url.startsWith(fixture.linkUrl)
          ).length,
        { timeout: 60_000, message: 'the link never opened as a browser tab on the host runtime' }
      )
      .toBe(1)
    // The host's browser really fetched it; a tab record alone would not prove a load.
    expect(fixture.linkLoadCount()).toBeGreaterThan(0)
    await expect
      .poll(() => readOwnedPageUrls(host.app, fixture.linkUrl), {
        timeout: 60_000,
        message: 'the runtime process never held a page for the link'
      })
      .toHaveLength(1)
    // Opening in background must leave the original pane selected.
    const hostRowsAtFirstOpen = await readHostServerPlacedBrowserUrls(host, worktreeId)
    const linkPageId = await waitForMirroredLinkPageId(
      page,
      environmentId,
      hostRowsAtFirstOpen,
      worktreeId,
      fixture.linkUrl
    )
    expect(await page.getByTestId('remote-browser-pane').count()).toBe(paneCountBeforeOpen)
    expect(await readRemotePaneUrls(page, worktreeId)).toContainEqual(
      expect.stringContaining(fixture.linkUrl)
    )
    await focusMirroredPage(page, worktreeId, linkPageId)
    await expect(page.getByTestId('remote-browser-pane')).toHaveCount(paneCountBeforeOpen + 1, {
      timeout: 60_000
    })
    expect(await readLocalBrowserViewUrls(page)).toHaveLength(0)

    await closeBrowserTabsExceptPane(page, worktreeId, fixture.paneUrl)
    await expect(page.getByTestId('remote-browser-pane')).toHaveCount(paneCountBeforeOpen, {
      timeout: 60_000
    })
    await expect
      .poll(
        async () =>
          (await readHostServerPlacedBrowserUrls(host, worktreeId)).filter((url) =>
            url.startsWith(fixture.linkUrl)
          ).length,
        { timeout: 60_000, message: 'the runtime kept the closed browser tab' }
      )
      .toBe(0)
    await focusMirroredPage(page, worktreeId, pane.pageId)
    const linkLoadsBeforeSecondAct = fixture.linkLoadCount()

    // Even client-hosted preference cannot override the remote pane’s runtime owner pin.
    await pinClientHostedPlacement(page, true)
    await openLinkFromRemotePaneContextMenu(page)

    await expect
      .poll(
        async () =>
          (await readHostServerPlacedBrowserUrls(host, worktreeId)).filter((url) =>
            url.startsWith(fixture.linkUrl)
          ).length,
        {
          timeout: 60_000,
          message: 'the owner-pinned link did not stay server-hosted'
        }
      )
      .toBe(1)
    expect(fixture.linkLoadCount()).toBeGreaterThan(linkLoadsBeforeSecondAct)
    await expect
      .poll(() => readOwnedPageUrls(host.app, fixture.linkUrl), {
        timeout: 60_000,
        message: 'the server-hosted guest never loaded the link on the pane runtime'
      })
      .toHaveLength(1)
    expect(await readOwnedPageUrls(client!.app, fixture.linkUrl)).toHaveLength(0)
    const hostRowsAtOwnerPinnedOpen = await readHostServerPlacedBrowserUrls(host, worktreeId)
    const ownerPinnedLinkPageId = await waitForMirroredLinkPageId(
      page,
      environmentId,
      hostRowsAtOwnerPinnedOpen,
      worktreeId,
      fixture.linkUrl
    )
    expect(await page.getByTestId('remote-browser-pane').count()).toBe(paneCountBeforeOpen)
    await focusMirroredPage(page, worktreeId, ownerPinnedLinkPageId)
    await expect(page.getByTestId('remote-browser-pane')).toHaveCount(paneCountBeforeOpen + 1, {
      timeout: 60_000
    })
    expect(await readLocalBrowserViewUrls(page)).toHaveLength(0)

    // Client close drops rows before host teardown; settle mirror, host inventory and guest before the next baseline.
    await closeBrowserTabsExceptPane(page, worktreeId, fixture.paneUrl)
    await expect
      .poll(() => findMirroredPage(page, worktreeId, fixture.linkUrl), {
        timeout: 60_000,
        message: 'the client kept the closed owner-pinned link tab'
      })
      .toBeNull()
    await expect
      .poll(
        async () =>
          (await readHostServerPlacedBrowserUrls(host, worktreeId)).filter((url) =>
            url.startsWith(fixture.linkUrl)
          ).length,
        { timeout: 60_000, message: 'the runtime kept the closed server-hosted page' }
      )
      .toBe(0)
    await expect
      .poll(() => readOwnedPageUrls(host.app, fixture.linkUrl), {
        timeout: 60_000,
        message: 'the server-hosted guest outlived the tab that owned it'
      })
      .toHaveLength(0)
    await focusMirroredPage(page, worktreeId, pane.pageId)

    // After workspace ownership moves local, refuse remote-pane links rather than load the runtime’s dev server here.
    await page.evaluate(
      ({ localHostId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, localHostId)
      },
      { localHostId: LOCAL_EXECUTION_HOST_ID, worktreeId } as const
    )
    await focusMirroredPage(page, worktreeId, pane.pageId)
    // Keep client placement enabled to prove refusal follows workspace ownership.
    await pinClientHostedPlacement(page, true)
    const hostPagesBefore = await readHostBrowserPageUrls(host.client, worktreeSelector)
    const linkLoadsBefore = fixture.linkLoadCount()

    await openLinkFromRemotePaneContextMenu(page)

    // Wait for refusal or a local page so a delayed fallback cannot escape the assertion.
    await expect
      .poll(() => readLinkOpenOutcome(client!, fixture.linkUrl), {
        timeout: 30_000,
        message: 'the link open produced neither a refusal nor a page'
      })
      .not.toBe('pending')
    expect(await readLinkOpenOutcome(client, fixture.linkUrl)).toBe('refused')

    expect(
      await page.evaluate(() => window.__store?.getState().activeWorkspaceExecutionHostId ?? null)
    ).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(await readOwnedPageUrls(client.app, fixture.linkUrl)).toHaveLength(0)
    expect(await readHostBrowserPageUrls(host.client, worktreeSelector)).toEqual(hostPagesBefore)
    expect(fixture.linkLoadCount()).toBe(linkLoadsBefore)
  } finally {
    if (client) {
      await client.dispose()
    }
    await host.dispose()
    await fixture.close()
  }
})
