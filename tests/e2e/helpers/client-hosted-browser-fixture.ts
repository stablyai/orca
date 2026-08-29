import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import type { PairedElectronClient } from './paired-electron-client'

/**
 * Shared scaffolding for the client-hosted browser survival specs.
 *
 * Extracted rather than copied a third time: every one of these specs has to distinguish "the tab
 * came back" from "a tab came back", and each private copy of that distinction is one more place it
 * can quietly weaken into a URL match that any fresh tab satisfies.
 */
export type ClientHostedMarkerFixture = {
  close(): Promise<void>
  markerUrl: string
  /** A second page the guest reaches on its own, to tell "survived" from "survived where". */
  movedUrl: string
  origin: string
}

export async function startClientHostedMarkerFixture(
  markers: { created: string; moved: string } = { created: 'survivor', moved: 'moved-on' }
): Promise<ClientHostedMarkerFixture> {
  const server = createServer((request, response) => {
    const marker = request.url === '/moved' ? markers.moved : markers.created
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

export type MirroredBrowserPage = {
  localPageId: string
  placementKind: 'client' | 'server' | null
  remotePageId: string
  url: string
  visibleTabId: string | null
  /** The browser workspace the tab strip renders as one row; its X is the product close. */
  workspaceId: string
}

export async function findPairedWorktreeId(page: Page, repoPath: string): Promise<string | null> {
  return page.evaluate(
    (path) =>
      window.__store
        ?.getState()
        .allWorktrees()
        .find((worktree) => worktree.path === path)?.id ?? null,
    repoPath
  )
}

export async function waitForPairedWorktreeId(page: Page, repoPath: string): Promise<string> {
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

export async function selectPairedWorktreeGroup(
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
      { timeout: 120_000, message: 'paired client never activated a tab group for the worktree' }
    )
    .not.toBeNull()
}

export async function findMirroredBrowserPage(
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
          const visibleTab = (state?.unifiedTabsByWorktree[worktreeId] ?? []).find(
            (tab) => tab.contentType === 'browser' && tab.entityId === workspace.id
          )
          return {
            localPageId: browserPage.id,
            placementKind: handle?.placement?.kind ?? null,
            remotePageId: handle?.remotePageId ?? browserPage.id,
            url: browserPage.url,
            visibleTabId: visibleTab?.id ?? null,
            workspaceId: workspace.id
          }
        }
      }
      return null
    },
    { url, worktreeId }
  )
}

/** Every browser row the client holds for a worktree, for diagnosing duplicates and culls. */
export async function readClientBrowserRows(
  page: Page,
  worktreeId: string
): Promise<{ pageId: string; placementKind: string | null; url: string }[]> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    const rows: { pageId: string; placementKind: string | null; url: string }[] = []
    for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
      for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
        rows.push({
          pageId: browserPage.id,
          placementKind:
            state?.remoteBrowserPageHandlesByPageId[browserPage.id]?.placement?.kind ?? null,
          url: browserPage.url
        })
      }
    }
    return rows
  }, worktreeId)
}

export async function openClientHostedFixturePage(
  client: PairedElectronClient,
  worktreeId: string,
  url: string
): Promise<MirroredBrowserPage> {
  await client.page.evaluate(async (url) => {
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
  await focusClientBrowserRow(client.page, worktreeId, mirrored.localPageId)
  return mirrored
}

/** Navigates the guest itself, the way following a link does — no client-side URL entry involved. */
export async function navigateGuest(page: Page, fromUrl: string, toUrl: string): Promise<void> {
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

/**
 * Reads the marker out of the guest belonging to one specific page.
 *
 * Bound to that page's retained host rather than scanning every `<webview>`: a scan by URL alone is
 * satisfied by any guest on the fixture origin, so a run that lost the surviving tab and opened a
 * fresh one would still read the moved marker and pass.
 */
export async function readClientWebviewMarker(
  page: Page,
  target: { urlPrefix: string; remotePageId: string }
): Promise<string | null> {
  return page.evaluate(async ({ urlPrefix, remotePageId }) => {
    const host = document.querySelector(
      `[data-browser-client-page-id="${CSS.escape(remotePageId)}"]`
    )
    for (const candidate of host?.querySelectorAll('webview') ?? []) {
      const webview = candidate as Electron.WebviewTag
      try {
        if (!webview.getURL().startsWith(urlPrefix)) {
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
  }, target)
}

export async function waitForRenderedClientWebview(
  page: Page,
  target: { urlPrefix: string; remotePageId: string },
  message: string
): Promise<string> {
  await expect
    .poll(() => readClientWebviewMarker(page, target), { timeout: 120_000, message })
    .not.toBeNull()
  const marker = await readClientWebviewMarker(page, target)
  if (!marker) {
    throw new Error(`Client-hosted guest for ${target.urlPrefix} lost its marker`)
  }
  return marker
}

/** Surfaces a row's pane so its guest is mounted where the scoped marker read can see it. */
export async function focusClientBrowserRow(
  page: Page,
  worktreeId: string,
  localPageId: string
): Promise<void> {
  await page.evaluate(
    ({ browserPageId, worktreeId }) => {
      window.__store?.getState().focusBrowserTabInWorktree(worktreeId, browserPageId, {
        surfacePane: true
      })
    },
    { browserPageId: localPageId, worktreeId }
  )
}

export async function refreshAuthorityRuntimeId(
  client: PairedElectronClient
): Promise<string | null> {
  return client.page
    .evaluate(async (environmentId) => {
      await window.api.runtimeEnvironments.connect({ selector: environmentId })
      await window.__store?.getState().refreshRuntimeEnvironmentStatus(environmentId)
      return (
        window.__store?.getState().runtimeStatusByEnvironmentId.get(environmentId)?.status
          ?.runtimeId ?? null
      )
    }, client.environmentId)
    .catch(() => null)
}

/** Waits until the client is talking to a genuinely new runtime process, not the one it paired to. */
export async function waitForRelaunchedRuntime(
  client: PairedElectronClient,
  previousRuntimeId: string
): Promise<void> {
  await expect
    .poll(() => refreshAuthorityRuntimeId(client), {
      timeout: 180_000,
      message: 'paired client never reconnected to a relaunched runtime process'
    })
    .toEqual(expect.not.stringMatching(`^${previousRuntimeId}$`))
}
