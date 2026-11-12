import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const OPERATION_ID = 'sta-4231-owner-pinned-navigation-hold'

type HeldNavigationServer = {
  close: () => Promise<void>
  pendingCount: () => number
  release: () => void
  sourceUrl: string
  url: string
}

type CreateOutcome = {
  error: string | null
  ok: boolean
  pageId: string | null
}

async function startHeldNavigationServer(): Promise<HeldNavigationServer> {
  const pending = new Set<ServerResponse>()
  const server: Server = createServer((request, response) => {
    if (request.url?.startsWith('/source')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        `<!doctype html><html><body style="margin:0"><a href="/hold?operation=${OPERATION_ID}" style="position:fixed;inset:0;display:block">open held page</a></body></html>`
      )
      return
    }
    if (!request.url?.startsWith('/hold')) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    pending.add(response)
    response.once('close', () => pending.delete(response))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  const release = (): void => {
    for (const response of pending) {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html><body>released</body></html>')
      }
    }
    pending.clear()
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        release()
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    pendingCount: () => pending.size,
    release,
    sourceUrl: `http://127.0.0.1:${port}/source`,
    url: `http://127.0.0.1:${port}/hold?operation=${OPERATION_ID}`
  }
}

async function readHostBrowserPageIds(
  hostClient: RuntimeClient,
  worktreeId: string
): Promise<string[]> {
  const response = await hostClient.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `id:${worktreeId}`
  })
  return response.result.tabs.flatMap((tab) =>
    tab.type === 'browser' && tab.browserPageId ? [tab.browserPageId] : []
  )
}

async function createOwnerPinnedBrowser(
  page: Page,
  environmentId: string,
  worktreeId: string,
  url: string
): Promise<CreateOutcome> {
  return page.evaluate(
    async ({ environmentId, url, worktreeId }) => {
      try {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'browser.tabCreate',
          params: {
            activate: true,
            url,
            waitForRegistration: true,
            worktree: `id:${worktreeId}`
          },
          timeoutMs: 15_000
        })
        if (!response.ok) {
          return {
            error: `${response.error.code}: ${response.error.message}`,
            ok: false,
            pageId: null
          }
        }
        const result = response.result as { browserPageId: string }
        return { error: null, ok: true, pageId: result.browserPageId }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
          pageId: null
        }
      }
    },
    { environmentId, url, worktreeId }
  )
}

async function findPairedWorktreeId(
  client: PairedElectronClient,
  repoPath: string
): Promise<string> {
  const worktreeId = await expect
    .poll(
      () =>
        client.page.evaluate(
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
      client.page.evaluate(
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

async function readClientBrowserPageIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    return (state?.browserTabsByWorktree[worktreeId] ?? []).flatMap((workspace) =>
      (state?.browserPagesByWorkspace[workspace.id] ?? []).map(
        (browserPage) =>
          state?.remoteBrowserPageHandlesByPageId[browserPage.id]?.remotePageId ?? browserPage.id
      )
    )
  }, worktreeId)
}

async function findMirroredPageId(
  page: Page,
  worktreeId: string,
  url: string
): Promise<string | null> {
  return page.evaluate(
    ({ url, worktreeId }) => {
      const state = window.__store?.getState()
      for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
        const browserPage = (state?.browserPagesByWorkspace[workspace.id] ?? []).find((candidate) =>
          candidate.url.startsWith(url)
        )
        if (browserPage) {
          return browserPage.id
        }
      }
      return null
    },
    { url, worktreeId }
  )
}

async function openLinkFromRemotePane(page: Page, testInfo: TestInfo): Promise<void> {
  const frame = page.locator('[data-testid="remote-browser-frame"]:visible').first()
  await expect(frame).toBeVisible({ timeout: 60_000 })
  await frame.click({ button: 'right', position: { x: 60, y: 60 }, force: true })
  const open = page.getByRole('menuitem', { name: 'Open Link In Orca Browser' })
  await expect(open).toBeVisible({ timeout: 30_000 })
  await page.screenshot({
    path: testInfo.outputPath('sta-4231-owner-pinned-link-route.png'),
    fullPage: true
  })
  await open.click()
}

test('returns a headed host page identity before owner-pinned navigation can time out @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo: TestInfo) => {
  test.setTimeout(300_000)
  const fixture = await startHeldNavigationServer()
  let client: PairedElectronClient | null = null
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const hostClient = new RuntimeClient(userDataDir, 5_000)
    client = await launchPairedElectronClient(offer, testInfo, 'STA-4231 navigation deadline')
    const cdp = await client.page.context().newCDPSession(client.page)
    const visibility = await cdp.send('Runtime.evaluate', {
      expression: 'document.visibilityState',
      returnByValue: true
    })
    expect(visibility.result.value).toBe('visible')
    const worktreeId = await findPairedWorktreeId(client, testRepoPath)
    const baselineHostPageIds = await readHostBrowserPageIds(hostClient, worktreeId)
    await client.page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )

    const firstPromise = createOwnerPinnedBrowser(
      client.page,
      client.environmentId,
      worktreeId,
      fixture.url
    )
    await expect.poll(fixture.pendingCount, { timeout: 30_000 }).toBe(1)
    const firstHostPageId = await expect
      .poll(
        async () => {
          const ids = await readHostBrowserPageIds(hostClient, worktreeId)
          return ids.find((id) => !baselineHostPageIds.includes(id)) ?? null
        },
        { timeout: 30_000, message: 'host never registered the owner-pinned page' }
      )
      .not.toBeNull()
      .then(async () => {
        const ids = await readHostBrowserPageIds(hostClient, worktreeId)
        return ids.find((id) => !baselineHostPageIds.includes(id)) ?? null
      })
    const first = await firstPromise

    let retry: CreateOutcome | null = null
    if (!first.ok) {
      const retryPromise = createOwnerPinnedBrowser(
        client.page,
        client.environmentId,
        worktreeId,
        fixture.url
      )
      await expect.poll(fixture.pendingCount, { timeout: 30_000 }).toBe(2)
      retry = await retryPromise
    }
    const hostPageIds = (await readHostBrowserPageIds(hostClient, worktreeId)).filter(
      (id) => !baselineHostPageIds.includes(id)
    )
    await expect
      .poll(() => readClientBrowserPageIds(client!.page, worktreeId), {
        timeout: 30_000,
        message: 'paired client did not materialize the canonical host page'
      })
      .toContain(firstHostPageId)
    await client.page.screenshot({
      path: testInfo.outputPath('sta-4231-headed-canonical-page.png'),
      fullPage: true
    })

    expect({ first, firstHostPageId, hostPageIds, retry }).toEqual({
      first: { error: null, ok: true, pageId: firstHostPageId },
      firstHostPageId,
      hostPageIds: [firstHostPageId],
      retry: null
    })
  } finally {
    fixture.release()
    await client?.dispose()
    await fixture.close()
  }
})

test('opens the held URL through the owner-pinned remote-pane link route @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo: TestInfo) => {
  test.setTimeout(300_000)
  const fixture = await startHeldNavigationServer()
  let client: PairedElectronClient | null = null
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const hostClient = new RuntimeClient(userDataDir, 5_000)
    client = await launchPairedElectronClient(offer, testInfo, 'STA-4231 owner-pinned link route')
    const worktreeId = await findPairedWorktreeId(client, testRepoPath)
    await client.page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    await hostClient.call('browser.tabCreate', {
      activate: true,
      url: fixture.sourceUrl,
      worktree: `id:${worktreeId}`
    })
    const sourcePageId = await expect
      .poll(() => findMirroredPageId(client!.page, worktreeId, fixture.sourceUrl), {
        timeout: 60_000,
        message: 'paired client never mirrored the source browser pane'
      })
      .not.toBeNull()
      .then(() => findMirroredPageId(client!.page, worktreeId, fixture.sourceUrl))
    if (!sourcePageId) {
      throw new Error('Source browser page disappeared')
    }
    await client.page.evaluate(
      ({ pageId, worktreeId }) =>
        window.__store?.getState().focusBrowserTabInWorktree(worktreeId, pageId, {
          surfacePane: true
        }),
      { pageId: sourcePageId, worktreeId }
    )
    const baselineHostPageIds = await readHostBrowserPageIds(hostClient, worktreeId)

    await openLinkFromRemotePane(client.page, testInfo)
    await expect.poll(fixture.pendingCount, { timeout: 30_000 }).toBe(1)
    const createdPageId = await expect
      .poll(
        async () => {
          const ids = await readHostBrowserPageIds(hostClient, worktreeId)
          return ids.find((id) => !baselineHostPageIds.includes(id)) ?? null
        },
        { timeout: 30_000, message: 'link route never registered a host page' }
      )
      .not.toBeNull()
      .then(async () => {
        const ids = await readHostBrowserPageIds(hostClient, worktreeId)
        return ids.find((id) => !baselineHostPageIds.includes(id)) ?? null
      })
    expect(createdPageId).not.toBeNull()
    await expect
      .poll(() => readClientBrowserPageIds(client!.page, worktreeId), {
        timeout: 30_000,
        message: 'link route did not materialize the canonical host page'
      })
      .toContain(createdPageId)
    expect(
      (await readHostBrowserPageIds(hostClient, worktreeId)).filter(
        (id) => !baselineHostPageIds.includes(id)
      )
    ).toEqual([createdPageId])
  } finally {
    fixture.release()
    await client?.dispose()
    await fixture.close()
  }
})
