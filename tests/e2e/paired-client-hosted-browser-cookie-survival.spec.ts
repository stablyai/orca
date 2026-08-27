import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

const COOKIE_NAME = 'sta4150'
const COOKIE_VALUE = 'survivor'
const ROUTE_PARTITION_RE = /^persist:orca-browser-v1-[a-f0-9]{64}$/

type CookieFixture = {
  close(): Promise<void>
  echoAfterUrl: string
  echoBeforeUrl: string
  loginUrl: string
  observedCookieHeaders(): { cookie: string | null; path: string }[]
  origin: string
}

/**
 * Serves a login page that plants a persistent cookie and echo pages that render the
 * `Cookie` request header, so a rendered marker proves the jar reached the wire rather
 * than merely existing somewhere on the client.
 */
async function startCookieFixture(): Promise<CookieFixture> {
  const observed: { cookie: string | null; path: string }[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const cookie = request.headers.cookie ?? null
    observed.push({ cookie, path: url.pathname })
    const isLogin = url.pathname === '/login'
    const marker = isLogin ? 'login-marker' : `cookie:${cookie ?? 'none'}`
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      ...(isLogin
        ? {
            'set-cookie': `${COOKIE_NAME}=${COOKIE_VALUE}; Max-Age=3600; Path=/; SameSite=Lax`
          }
        : {})
    })
    response.end(
      `<!doctype html><html><head><title>${marker}</title></head><body><h1 id="marker">${marker}</h1></body></html>`
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
    echoAfterUrl: `${origin}/echo/after`,
    echoBeforeUrl: `${origin}/echo/before`,
    loginUrl: `${origin}/login`,
    observedCookieHeaders: () => [...observed],
    origin
  }
}

type MirroredBrowserPage = {
  localPageId: string
  placementKind: 'client' | 'server' | null
  remotePageId: string
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
            remotePageId: handle?.remotePageId ?? browserPage.id
          }
        }
      }
      return null
    },
    { url, worktreeId }
  )
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

async function readClientWebview(
  page: Page,
  url: string
): Promise<{ marker: string | null; partition: string | null } | null> {
  return page.evaluate(async (prefix) => {
    for (const candidate of document.querySelectorAll('webview')) {
      const webview = candidate as Electron.WebviewTag
      try {
        if (!webview.getURL().startsWith(prefix)) {
          continue
        }
        return {
          marker: (await webview.executeJavaScript(
            'document.querySelector("#marker")?.textContent ?? null'
          )) as string | null,
          partition: webview.getAttribute('partition')
        }
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
): Promise<{ marker: string; partition: string }> {
  await expect
    .poll(async () => (await readClientWebview(page, url))?.marker ?? null, {
      timeout: 120_000,
      message
    })
    .not.toBeNull()
  const rendered = await readClientWebview(page, url)
  if (!rendered?.marker || !rendered.partition) {
    throw new Error(`Client-hosted guest for ${url} lost its marker or partition`)
  }
  return { marker: rendered.marker, partition: rendered.partition }
}

/** Reads the fixture cookie out of a named client partition, or the default session when null. */
async function readClientSessionCookie(
  app: ElectronApplication,
  partition: string | null,
  url: string
): Promise<string | null> {
  return app.evaluate(
    async ({ session }, { name, partition, url }) => {
      const target = partition === null ? session.defaultSession : session.fromPartition(partition)
      const cookies = await target.cookies.get({ name, url })
      return cookies[0]?.value ?? null
    },
    { name: COOKIE_NAME, partition, url }
  )
}

/** Re-reads the runtime's per-process id from the live connection, not the cached status. */
async function refreshAuthorityRuntimeId(client: PairedElectronClient): Promise<string | null> {
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

/**
 * Waits until the client is talking to a genuinely new runtime process. A changed
 * `runtimeId` is the point of the test: it is the per-process value the partition scheme
 * deliberately stopped hashing, so the cookie must survive precisely while it changes.
 */
async function waitForRelaunchedRuntime(
  client: PairedElectronClient,
  previousRuntimeId: string
): Promise<string> {
  await expect
    .poll(() => refreshAuthorityRuntimeId(client), {
      timeout: 180_000,
      message: 'paired client never reconnected to a relaunched runtime process'
    })
    .toEqual(expect.not.stringMatching(`^${previousRuntimeId}$`))
  const runtimeId = await refreshAuthorityRuntimeId(client)
  if (!runtimeId) {
    throw new Error('Paired client lost the runtime id after reconnecting')
  }
  return runtimeId
}

test('keeps client-hosted browser cookies across a paired runtime restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await startCookieFixture()
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let client: PairedElectronClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(
      host.offer,
      testInfo,
      'STA-4150 client-hosted cookie survival'
    )
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)

    await openClientHostedFixturePage(client, worktreeId, fixture.loginUrl)
    const login = await waitForRenderedClientWebview(
      client.page,
      fixture.loginUrl,
      'client-hosted guest never rendered the login fixture'
    )
    expect(login.marker).toBe('login-marker')
    expect(login.partition, 'client-hosted pages must use a derived route partition').toMatch(
      ROUTE_PARTITION_RE
    )

    await openClientHostedFixturePage(client, worktreeId, fixture.echoBeforeUrl)
    const echoBefore = await waitForRenderedClientWebview(
      client.page,
      fixture.echoBeforeUrl,
      'client-hosted guest never rendered the pre-restart echo fixture'
    )
    expect(echoBefore.marker).toContain(`${COOKIE_NAME}=${COOKIE_VALUE}`)
    expect(echoBefore.partition).toBe(login.partition)

    // Negative control: the jar belongs to the route partition, not to the client at large.
    expect(
      await readClientSessionCookie(client.app, login.partition, fixture.origin),
      'route partition must hold the fixture cookie'
    ).toBe(COOKIE_VALUE)
    expect(
      await readClientSessionCookie(client.app, null, fixture.origin),
      'the client default session must never see a route-partition cookie'
    ).toBeNull()

    const runtimeIdBeforeRestart = await refreshAuthorityRuntimeId(client)
    expect(runtimeIdBeforeRestart, 'client must know the runtime it is paired with').not.toBeNull()
    const hostPidBeforeRestart = host.app.process().pid

    await host.restartServeProcess()
    expect(host.app.process().pid, 'the serve process must actually be replaced').not.toBe(
      hostPidBeforeRestart
    )
    await waitForRelaunchedRuntime(client, runtimeIdBeforeRestart!)
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' }).catch(() => undefined)
    const restartedWorktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, restartedWorktreeId)

    await openClientHostedFixturePage(client, restartedWorktreeId, fixture.echoAfterUrl)
    const echoAfter = await waitForRenderedClientWebview(
      client.page,
      fixture.echoAfterUrl,
      'client-hosted guest never rendered the post-restart echo fixture'
    )
    expect(
      echoAfter.partition,
      'a runtime restart must not mint a fresh client-hosted partition'
    ).toBe(login.partition)
    expect(
      echoAfter.marker,
      'the post-restart request must still carry the cookie planted before the restart'
    ).toContain(`${COOKIE_NAME}=${COOKIE_VALUE}`)

    const afterRequest = fixture
      .observedCookieHeaders()
      .findLast((entry) => entry.path === '/echo/after')
    expect(afterRequest?.cookie, 'fixture server must have seen the surviving cookie').toContain(
      `${COOKIE_NAME}=${COOKIE_VALUE}`
    )
    const loginRequest = fixture.observedCookieHeaders().find((entry) => entry.path === '/login')
    expect(loginRequest?.cookie ?? null, 'the first request must arrive without the cookie').toBe(
      null
    )
  } finally {
    await client?.dispose()
    await host.dispose()
    await fixture.close()
  }
})
