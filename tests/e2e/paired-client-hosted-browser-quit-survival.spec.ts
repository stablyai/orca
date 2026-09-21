import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { readHostBrowserPageIds, readHostBrowserPageUrl } from './helpers/host-session-tabs'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

const CLIENT_NAME = 'STA-4150 client-hosted quit survival'
/** Longer than the runtime's 15s reconnect grace, so the relaunch is a cold one. */
const RECONNECT_GRACE_OVERSHOOT_MS = 25_000

type MarkerFixture = {
  close(): Promise<void>
  markerUrl: string
  /** A second page the guest can reach on its own, to tell "restored" from "restored where". */
  movedUrl: string
  origin: string
}

/** Serves identifiable pages, so a rendered marker proves the guest really navigated. */
async function startMarkerFixture(): Promise<MarkerFixture> {
  const server = createServer((request, response) => {
    const marker = request.url === '/moved' ? 'moved-on' : 'quit-survivor'
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    })
    response.end(
      `<!doctype html><html><head><title>${marker}</title></head>` +
        `<body><h1 id="marker">${marker}</h1></body></html>`
    )
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    markerUrl: `${origin}/survivor`,
    movedUrl: `${origin}/moved`,
    origin
  }
}

/** Navigates the guest itself, the way following a link does — no client-side URL entry involved. */
async function navigateGuest(page: Page, fromUrl: string, toUrl: string): Promise<void> {
  const navigated = await page.evaluate(
    async ({ fromUrl, toUrl }) => {
      for (const candidate of document.querySelectorAll('webview')) {
        const webview = candidate as Electron.WebviewTag
        try {
          if (!webview.getURL().startsWith(fromUrl)) {
            continue
          }
          await webview.loadURL(toUrl)
          return true
        } catch {
          // The guest may still be attaching.
        }
      }
      return false
    },
    { fromUrl, toUrl }
  )
  if (!navigated) {
    throw new Error(`No client-hosted guest was showing ${fromUrl} to navigate`)
  }
}

type MirroredBrowserPage = {
  localPageId: string
  placementKind: 'client' | 'server' | null
  remotePageId: string
  url: string
}

async function findPairedWorktreeId(page: Page, repoPath: string): Promise<string | null> {
  return page.evaluate(
    (path) =>
      window.__store
        ?.getState()
        .allWorktrees()
        .find((worktree) => worktree.path === path)?.id ?? null,
    repoPath
  )
}

async function waitForPairedWorktreeId(page: Page, repoPath: string): Promise<string> {
  await expect
    .poll(() => findPairedWorktreeId(page, repoPath), {
      timeout: 120_000,
      message: 'paired client never received the host worktree'
    })
    .not.toBeNull()
  const worktreeId = await findPairedWorktreeId(page, repoPath)
  if (!worktreeId) {
    throw new Error('Paired worktree disappeared after discovery')
  }
  return worktreeId
}

async function selectPairedWorktreeGroup(
  page: Page,
  environmentId: string,
  worktreeId: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ environmentId, worktreeId }) => {
            const state = window.__store?.getState()
            state?.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
            return state?.activeGroupIdByWorktree[worktreeId] ?? null
          },
          { environmentId, worktreeId }
        ),
      {
        timeout: 120_000,
        message: 'paired client never activated a tab group for the worktree'
      }
    )
    .not.toBeNull()
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
            url: browserPage.url
          }
        }
      }
      return null
    },
    { url, worktreeId }
  )
}

/** Every browser row the client holds for a worktree, for diagnosing duplicates and culls. */
async function readClientBrowserRows(
  page: Page,
  worktreeId: string
): Promise<{ pageId: string; placementKind: string | null; url: string; workspaceId: string }[]> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    const rows: {
      pageId: string
      placementKind: string | null
      url: string
      workspaceId: string
    }[] = []
    for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
      for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
        rows.push({
          pageId: browserPage.id,
          placementKind:
            state?.remoteBrowserPageHandlesByPageId[browserPage.id]?.placement?.kind ?? null,
          url: browserPage.url,
          workspaceId: workspace.id
        })
      }
    }
    return rows
  }, worktreeId)
}

/**
 * What the client-hosted pane has settled on: its guest, the unavailable notice, or still waiting.
 * Read off the rendered pane rather than the store, because "the spinner never stops" is a
 * rendering fact and the store field behind it looks the same either way.
 */
async function readClientHostedPaneResolution(
  page: Page
): Promise<'guest' | 'unavailable' | 'waiting'> {
  return page.evaluate(() => {
    if (document.querySelector('webview')) {
      return 'guest'
    }
    const heading = [...document.querySelectorAll('div')].some(
      (node) => node.textContent === 'Client-hosted browser unavailable'
    )
    return heading ? 'unavailable' : 'waiting'
  })
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

async function openClientHostedFixturePage(
  client: PairedElectronClient,
  worktreeId: string,
  url: string
): Promise<MirroredBrowserPage> {
  await createProductBrowserPage(client.page, url)
  await expect
    .poll(() => findMirroredBrowserPage(client.page, worktreeId, url), {
      timeout: 60_000,
      message: `paired client never materialized ${url}`
    })
    .not.toBeNull()
  const mirrored = await findMirroredBrowserPage(client.page, worktreeId, url)
  if (!mirrored) {
    throw new Error(`Mirrored browser page disappeared for ${url}`)
  }
  expect(mirrored.placementKind, 'fixture page must be hosted on the viewing desktop').toBe(
    'client'
  )
  await client.page.evaluate(
    ({ browserPageId, worktreeId }) => {
      window.__store?.getState().focusBrowserTabInWorktree(worktreeId, browserPageId, {
        surfacePane: true
      })
    },
    { browserPageId: mirrored.localPageId, worktreeId }
  )
  return mirrored
}

async function readClientWebviewMarker(page: Page, url: string): Promise<string | null> {
  return page.evaluate(async (prefix) => {
    for (const candidate of document.querySelectorAll('webview')) {
      const webview = candidate as Electron.WebviewTag
      try {
        if (!webview.getURL().startsWith(prefix)) {
          continue
        }
        return (await webview.executeJavaScript(
          'document.querySelector("#marker")?.textContent ?? null'
        )) as string | null
      } catch {
        // The guest may still be attaching.
      }
    }
    return null
  }, url)
}

async function waitForRenderedClientWebview(
  page: Page,
  url: string,
  message: string
): Promise<string> {
  await expect
    .poll(() => readClientWebviewMarker(page, url), { timeout: 120_000, message })
    .not.toBeNull()
  const marker = await readClientWebviewMarker(page, url)
  if (!marker) {
    throw new Error(`Client-hosted guest for ${url} lost its marker`)
  }
  return marker
}

test('keeps a client-hosted browser tab across a client quit and relaunch', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(420_000)
  const fixture = await startMarkerFixture()
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  let abandonedProfile: string | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, CLIENT_NAME)
    const profileDir = client.userDataDir
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)

    const opened = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
    expect(
      await waitForRenderedClientWebview(
        client.page,
        fixture.markerUrl,
        'client-hosted guest never rendered the fixture before the quit'
      )
    ).toBe('quit-survivor')

    expect(
      await readHostBrowserPageIds(host.client, testRepoPath),
      'the runtime must hold the client-hosted page before the quit'
    ).toContain(opened.remotePageId)

    // Why the guest moves before the quit: with the tab still on its create URL, restoring to the
    // create URL and restoring to where the user was are the same answer, and the test cannot tell
    // a working restore from one that just replays the URL the tab was born on.
    await navigateGuest(client.page, fixture.markerUrl, fixture.movedUrl)
    expect(
      await waitForRenderedClientWebview(
        client.page,
        fixture.movedUrl,
        'the guest never rendered the page it navigated to'
      )
    ).toBe('moved-on')

    await expect
      .poll(() => readHostBrowserPageUrl(host.client, testRepoPath, opened.remotePageId), {
        timeout: 60_000,
        message: 'the runtime never learned where the guest navigated'
      })
      .toBe(fixture.movedUrl)

    // Quit without disposing: the profile has to outlive the app, as it does for a real Cmd+Q.
    const quitting = client.app
    client = null
    abandonedProfile = profileDir
    await closeElectronAppForE2E(quitting)

    // Past the reconnect grace the runtime has decided the host is gone for good.
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_GRACE_OVERSHOOT_MS))
    expect(
      await readHostBrowserPageIds(host.client, testRepoPath),
      'the runtime must retain a client-hosted page whose host quit'
    ).toContain(opened.remotePageId)

    client = await launchPairedElectronClient(host.offer, testInfo, CLIENT_NAME, {
      reuseUserDataDir: profileDir
    })
    abandonedProfile = null
    const relaunchedWorktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, relaunchedWorktreeId)

    await expect
      .poll(() => findMirroredBrowserPage(client!.page, relaunchedWorktreeId, fixture.movedUrl), {
        timeout: 120_000,
        message: 'the relaunched client never restored the client-hosted tab where the guest was'
      })
      .not.toBeNull()

    // Counted across the whole fixture origin, not just the moved URL: a restore that also replays
    // the create URL leaves two rows, and matching only the moved one would call that a pass.
    const rows = await readClientBrowserRows(client.page, relaunchedWorktreeId)
    const survivorRows = rows.filter((row) => row.url.startsWith(fixture.origin))
    expect(survivorRows, 'the restored tab must come back exactly once').toHaveLength(1)

    await expect
      .poll(
        async () =>
          (await findMirroredBrowserPage(client!.page, relaunchedWorktreeId, fixture.movedUrl))
            ?.placementKind ?? null,
        {
          timeout: 120_000,
          message: 'the restored tab never became client-hosted again'
        }
      )
      .toBe('client')

    const restored = await findMirroredBrowserPage(
      client.page,
      relaunchedWorktreeId,
      fixture.movedUrl
    )
    expect(restored?.remotePageId, 'recovery must keep the page identity it was created with').toBe(
      opened.remotePageId
    )

    await client.page.evaluate(
      ({ browserPageId, worktreeId }) => {
        window.__store?.getState().focusBrowserTabInWorktree(worktreeId, browserPageId, {
          surfacePane: true
        })
      },
      { browserPageId: restored!.localPageId, worktreeId: relaunchedWorktreeId }
    )
    expect(
      await waitForRenderedClientWebview(
        client.page,
        fixture.movedUrl,
        'the restored client-hosted tab never rendered its page again'
      ),
      'a restored tab has to come back functional and where the user left it'
    ).toBe('moved-on')
  } finally {
    await client?.dispose()
    if (abandonedProfile) {
      await cleanupE2EDaemons(abandonedProfile).catch(() => undefined)
    }
    await host.dispose()
    await fixture.close()
  }
})

// Why: retention is only safe if a retained tab can still be dismissed. The comment that justified
// retiring on a fence warned the tab would otherwise stay listed and un-closeable for the life of
// the runtime, so that warning is the acceptance criterion for keeping it.
test('closes a retained client-hosted tab while its host is gone', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(420_000)
  const fixture = await startMarkerFixture()
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  let abandonedProfile: string | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, CLIENT_NAME)
    const profileDir = client.userDataDir
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
    const opened = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
    await waitForRenderedClientWebview(
      client.page,
      fixture.markerUrl,
      'client-hosted guest never rendered the fixture before the quit'
    )

    const quitting = client.app
    client = null
    abandonedProfile = profileDir
    await closeElectronAppForE2E(quitting)
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_GRACE_OVERSHOOT_MS))
    expect(await readHostBrowserPageIds(host.client, testRepoPath)).toContain(opened.remotePageId)

    await expect(
      host.client.call('browser.tabClose', {
        worktree: `path:${testRepoPath}`,
        page: opened.remotePageId
      }),
      'a retained tab must close without its absent host answering'
    ).resolves.toMatchObject({ result: { closed: true } })

    expect(
      await readHostBrowserPageIds(host.client, testRepoPath),
      'the closed tab must leave the runtime for good'
    ).not.toContain(opened.remotePageId)

    // The other half of "closeable while absent" is what the desktop does when it comes back to a
    // page nobody has any more. Its own session still lists the row and nothing will ever publish
    // it, so the row has to resolve on its own and then go when the user says so.
    client = await launchPairedElectronClient(host.offer, testInfo, CLIENT_NAME, {
      reuseUserDataDir: profileDir
    })
    abandonedProfile = null
    const relaunchedWorktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, relaunchedWorktreeId)

    // Presence before absence: without this, every check below passes on a row that never restored.
    await expect
      .poll(() => findMirroredBrowserPage(client!.page, relaunchedWorktreeId, fixture.markerUrl), {
        timeout: 120_000,
        message: 'the relaunched client never restored the row its own session persisted'
      })
      .not.toBeNull()
    const orphaned = await findMirroredBrowserPage(
      client.page,
      relaunchedWorktreeId,
      fixture.markerUrl
    )
    await client.page.evaluate(
      ({ browserPageId, worktreeId }) => {
        window.__store?.getState().focusBrowserTabInWorktree(worktreeId, browserPageId, {
          surfacePane: true
        })
      },
      { browserPageId: orphaned!.localPageId, worktreeId: relaunchedWorktreeId }
    )

    await expect
      .poll(() => readClientHostedPaneResolution(client!.page), {
        timeout: 180_000,
        message: 'the restored row never stopped waiting for a host that cannot answer'
      })
      .toBe('unavailable')

    await client.page.evaluate((browserPageId) => {
      window.__store?.getState().closeBrowserPage(browserPageId)
    }, orphaned!.localPageId)
    await expect
      .poll(
        async () =>
          (await readClientBrowserRows(client!.page, relaunchedWorktreeId)).filter((row) =>
            row.url.startsWith(fixture.origin)
          ).length,
        { timeout: 60_000, message: 'the orphaned row never left the client tab strip' }
      )
      .toBe(0)
  } finally {
    await client?.dispose()
    if (abandonedProfile) {
      await cleanupE2EDaemons(abandonedProfile).catch(() => undefined)
    }
    await host.dispose()
    await fixture.close()
  }
})
