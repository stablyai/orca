import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type Fixture = { close(): Promise<void>; first: string; second: string }

type MetadataPublishFaultWindow = Window & {
  __browserClientPageMetadataPublishFault?: {
    suppress: () => void
    resume: () => void
    snapshot: () => { suppressed: boolean }
  }
}

async function startFixture(): Promise<Fixture> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const title = url.pathname === '/two' ? 'Fixture Maps Two' : 'Fixture Maps One'
    response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html' })
    response.end(`<!doctype html><html><head><title>${title}</title></head><body>
      <h1 id="marker">${title}</h1></body></html>`)
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
    first: `${origin}/one`,
    second: `${origin}/two`
  }
}

async function findWorktreeId(page: Page, repoPath: string): Promise<string> {
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
      { timeout: 60_000 }
    )
    .not.toBeNull()
  return (await page.evaluate(
    (path) =>
      window.__store
        ?.getState()
        .allWorktrees()
        .find((worktree) => worktree.path === path)?.id ?? null,
    repoPath
  )) as string
}

async function mirroredPage(
  page: Page,
  worktreeId: string,
  url: string
): Promise<{
  localPageId: string
  placementHostId: string | null
  placementKind: string | null
  remotePageId: string | null
  title: string
} | null> {
  return page.evaluate(
    ({ url, worktreeId }) => {
      const state = window.__store?.getState()
      for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
        for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
          if (!browserPage.url.startsWith(url)) {
            continue
          }
          const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
          const placement = handle?.placement
          return {
            localPageId: browserPage.id,
            placementHostId:
              placement && placement.kind === 'client' ? placement.browserHostClientId : null,
            placementKind: placement?.kind ?? null,
            remotePageId: handle?.remotePageId ?? null,
            title: browserPage.title
          }
        }
      }
      return null
    },
    { url, worktreeId }
  )
}

/**
 * What the host publishes for one browser row, taken over the same projection its pushed snapshots
 * are built from (`session.tabs.list` and `session.tabs.subscribe` both emit
 * projectSessionTabsForClient over listMobileSessionTabs), so this is the payload content — not a
 * re-derivation of it. Null once the host stops carrying the row at all.
 */
async function hostPublishedBrowserTitle(
  client: PairedElectronClient,
  worktreeId: string,
  remotePageId: string
): Promise<string | null> {
  const snapshot = await client.page.evaluate(
    async ({ environmentId, worktreeId }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'session.tabs.list',
        params: { worktree: `id:${worktreeId}` }
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result as { tabs: { browserPageId?: string; title?: string }[] }
    },
    { environmentId: client.environmentId, worktreeId }
  )
  return snapshot.tabs.find((tab) => tab.browserPageId === remotePageId)?.title ?? null
}

/** Resolves once this client's guest for `prefix` is attached and reachable. */
async function waitForClientGuest(page: Page, prefix: string, message: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((prefix) => {
          for (const candidate of document.querySelectorAll('webview')) {
            const webview = candidate as Electron.WebviewTag
            try {
              if (webview.getURL().startsWith(prefix)) {
                return true
              }
            } catch {
              // still attaching
            }
          }
          return false
        }, prefix),
      { timeout: 60_000, message }
    )
    .toBe(true)
}

async function run(args: {
  offer: RuntimeDesktopPairingOffer
  repoPath: string
  testInfo: TestInfo
}): Promise<void> {
  const fixture = await startFixture()
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(args.offer, args.testInfo, 'STA-4150 identity probe')
    const page = client.page
    const worktreeId = await findWorktreeId(page, args.repoPath)
    await page.evaluate(
      ({ environmentId, worktreeId }) =>
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`),
      { environmentId: client.environmentId, worktreeId }
    )

    await page.evaluate(async (url) => {
      const state = window.__store?.getState()
      const groupId = state?.activeGroupIdByWorktree[state.activeWorktreeId ?? '']
      state?.setBrowserDefaultUrl(url)
      await state?.openNewBrowserTabInActiveWorkspace(groupId as string)
    }, fixture.first)

    await expect
      .poll(() => mirroredPage(page, worktreeId, fixture.first), { timeout: 60_000 })
      .not.toBeNull()
    const mirrored = await mirroredPage(page, worktreeId, fixture.first)
    expect(mirrored?.placementKind).toBe('client')

    // Why assert the identity and not just the title: the title holds for two different reasons —
    // because this client recognised its own guest, or because no host snapshot happened to land.
    // Only the first is the behaviour under test, and it is the one an id mismatch would break.
    const rendererHostId = await page.evaluate(
      () => window.api.browser.readClientHostId?.() ?? null
    )
    expect(rendererHostId).not.toBeNull()
    expect(rendererHostId).toBe(mirrored?.placementHostId)

    const pageId = mirrored?.localPageId as string
    await page.evaluate(
      ({ pageId, worktreeId }) =>
        window.__store
          ?.getState()
          .focusBrowserTabInWorktree(worktreeId, pageId, { surfacePane: true }),
      { pageId, worktreeId }
    )

    // Drive the guest somewhere the host was never told about, then sample every title the store
    // publishes while the tab is toggled and the worktree is switched away and back.
    await waitForClientGuest(page, fixture.first, 'client-hosted guest never attached')

    // Why the publish is held back, and only now that the guest owns the pane: a client-hosted page
    // reports its navigations to the runtime, so the runtime normally catches up within a
    // round-trip and the two never disagree long enough to sample. The carve-out under test covers
    // that window and a publish that never lands at all; suppressing one holds the window open.
    // Asserted rather than fired blind — an absent fault would leave the premise silently false.
    expect(
      await page.evaluate(() => {
        const fault = (window as MetadataPublishFaultWindow).__browserClientPageMetadataPublishFault
        fault?.suppress()
        return fault?.snapshot() ?? null
      })
    ).toEqual({ suppressed: true })
    await page.evaluate(
      async ({ prefix, url }) => {
        for (const candidate of document.querySelectorAll('webview')) {
          const webview = candidate as Electron.WebviewTag
          if (webview.getURL().startsWith(prefix)) {
            await webview.loadURL(url)
            return
          }
        }
        throw new Error('no client-hosted guest to navigate')
      },
      { prefix: fixture.first, url: fixture.second }
    )
    await expect
      .poll(async () => (await mirroredPage(page, worktreeId, fixture.second))?.title ?? null, {
        timeout: 60_000,
        message: 'guest never reported the second fixture title'
      })
      .toBe('Fixture Maps Two')

    // The value a regression would land on this row is whatever the host publishes for it, so the
    // oracle is read from the host rather than guessed at: the host never saw the local navigation,
    // so its title is still the create-time one and disagrees with the guest's.
    const remotePageId = (await mirroredPage(page, worktreeId, fixture.second))
      ?.remotePageId as string
    expect(remotePageId).toBeTruthy()
    const hostTitle = await hostPublishedBrowserTitle(client, worktreeId, remotePageId)
    expect(hostTitle).toBeTruthy()
    expect(hostTitle).not.toBe('Fixture Maps Two')

    await page.evaluate((pageId) => {
      const observed: string[] = []
      ;(window as unknown as { __titles: string[] }).__titles = observed
      window.__store?.subscribe((state) => {
        for (const pages of Object.values(state.browserPagesByWorkspace)) {
          for (const browserPage of pages) {
            if (browserPage.id === pageId) {
              observed.push(browserPage.title)
            }
          }
        }
      })
    }, pageId)

    // A host republish is what rebuilds the row, so the sampling window has to contain one: each
    // new browser tab makes the host publish a fresh session-tab snapshot carrying every row.
    let republishes = 0
    for (let round = 0; round < 3; round += 1) {
      const roundUrl = `${fixture.first}?round=${round}`
      await page.evaluate(
        async ({ url }) => {
          const state = window.__store?.getState()
          const groupId = state?.activeGroupIdByWorktree[state.activeWorktreeId ?? '']
          state?.setBrowserDefaultUrl(url)
          await state?.openNewBrowserTabInActiveWorkspace(groupId as string)
        },
        { url: roundUrl }
      )
      // Why this stands in for a sleep: a placement reaches the store only where the sync applies a
      // host snapshot, so the new row carrying one is proof a fresh republish of this worktree
      // landed at the client — and one snapshot carries every row of the worktree, ours included.
      await expect
        .poll(async () => (await mirroredPage(page, worktreeId, roundUrl))?.placementKind ?? null, {
          timeout: 60_000,
          message: `round ${round}: no host snapshot reached the client`
        })
        .toBe('client')
      expect(
        await hostPublishedBrowserTitle(client, worktreeId, remotePageId),
        `round ${round}: the host stopped publishing the watched row`
      ).toBe(hostTitle)
      republishes += 1
      await page.evaluate(
        ({ pageId, worktreeId }) => {
          const state = window.__store?.getState()
          state?.setActiveTabType('terminal')
          state?.focusBrowserTabInWorktree(worktreeId, pageId, { surfacePane: true })
        },
        { pageId, worktreeId }
      )
      await waitForClientGuest(page, fixture.second, `round ${round}: guest never came back`)
    }

    const titles = (await page.evaluate(
      () => (window as unknown as { __titles: string[] }).__titles
    )) as string[]
    // Without a republish carrying the host's own title for this row inside the window, the
    // not-toContain below passes on a test that exercised nothing. The per-round poll and title
    // check are what enforce that; this counts the rounds that cleared them.
    expect(republishes).toBeGreaterThan(0)
    expect(titles).not.toContain(hostTitle)
    // Why the literal as well: the host publishes `title || url || 'Browser'`, so hostTitle would
    // silently become the url if the registry ever learned one, leaving the default unguarded.
    expect(titles).not.toContain('Browser')
    expect((await mirroredPage(page, worktreeId, fixture.second))?.title).toBe('Fixture Maps Two')
  } finally {
    await client?.dispose()
    await fixture.close()
  }
}

test('holds the guest title through host republishes of a client-hosted page', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  await run({ offer, repoPath: testRepoPath, testInfo })
})
