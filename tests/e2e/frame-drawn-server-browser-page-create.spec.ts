/**
 * A switch-on desktop paired to a switch-on `orca serve` draws the server's workspace from its
 * layout frames. A page the desktop adds to a server browser tab (reopening a closed page does
 * this) joins that tab on the server, so the next frame shows one tab with both pages, not a
 * second blank tab; closing the page leaves the tab with its first page (L292).
 *
 * Run (switch-on build: ORCA_LAYOUT_OWNER=main ... --mode e2e):
 *   pnpm exec playwright test tests/e2e/frame-drawn-server-browser-page-create.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { createServer } from 'node:http'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { LAYOUT_OWNER_BUILD } from './helpers/layout-owner-build'
import { launchPairedElectronClient } from './helpers/paired-electron-client'

type DrawnBrowserTabs = { id: string; pages: { id: string; url: string }[] }[]

function drawnBrowserTabs(page: Page, worktreeId: string): Promise<DrawnBrowserTabs> {
  return page.evaluate((wt) => {
    const state = window.__store!.getState()
    return (state.browserTabsByWorktree[wt] ?? []).map((tab) => ({
      id: tab.id,
      pages: (state.browserPagesByWorkspace[tab.id] ?? []).map((entry) => ({
        id: entry.id,
        url: entry.url
      }))
    }))
  }, worktreeId)
}

test('a page added to a frame-drawn server browser tab joins that tab on the server', async ({
  testRepoPath
}, testInfo) => {
  test.skip(!LAYOUT_OWNER_BUILD, 'Needs a layout-owner build (ORCA_LAYOUT_OWNER=main)')
  test.setTimeout(240_000)
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><head><title>page</title></head><body>page</body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('the page server has no port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const host = await launchHeadlessPairedRuntimeHost()
  const client = await launchPairedElectronClient(host.offer, testInfo, 'L292 page create')
  // Any layout change makes the server publish a frame.
  const nextFrame = async (title: string): Promise<void> => {
    await host.client.call('terminal.create', { worktree: `path:${testRepoPath}`, title })
  }
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', { worktree: `path:${testRepoPath}`, title: 't1' })
    const { page } = client
    let worktreeId = ''
    await expect
      .poll(
        async () => {
          worktreeId = await page.evaluate(
            (repoPath) =>
              window
                .__store!.getState()
                .allWorktrees()
                .find((worktree) => worktree.path === repoPath)?.id ?? '',
            testRepoPath
          )
          return worktreeId
        },
        { timeout: 60_000 }
      )
      .not.toBe('')
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ environmentId, wt }) => {
              const state = window.__store!.getState()
              if (state.activeWorktreeId !== wt) {
                state.setActiveView('terminal')
                state.setActiveWorktree(wt, `runtime:${environmentId}`)
              }
              return window.__isFrameDrawnServerWorkspaceE2E?.(environmentId, wt) === true
            },
            { environmentId: client.environmentId, wt: worktreeId }
          ),
        { timeout: 90_000 }
      )
      .toBe(true)
    // A server-hosted tab: its pages run on the server, so a new page is created there.
    await page.evaluate(async (url) => {
      const state = window.__store!.getState()
      await state.updateSettings({ browserClientHostedRemoteEnabled: false })
      state.setBrowserDefaultUrl(url)
      await state.openNewBrowserTabInActiveWorkspace(
        state.activeGroupIdByWorktree[state.activeWorktreeId!]!
      )
    }, `${origin}/a`)
    // The first page reports its address while it is the one shown.
    await expect
      .poll(() => drawnBrowserTabs(page, worktreeId), { timeout: 30_000 })
      .toEqual([
        expect.objectContaining({ pages: [expect.objectContaining({ url: `${origin}/a` })] })
      ])
    const [serverTab] = await drawnBrowserTabs(page, worktreeId)
    const firstPageId = serverTab!.pages[0]!.id

    const addedPageId = await page.evaluate(
      ({ tabId, url }) => window.__store!.getState().createBrowserPage(tabId, url)?.id ?? null,
      { tabId: serverTab!.id, url: `${origin}/b` }
    )
    expect(addedPageId).not.toBeNull()
    // The page's pane created it on the server once it holds the page's handle.
    await expect
      .poll(
        () =>
          page.evaluate(
            (pageId) =>
              window.__store!.getState().remoteBrowserPageHandlesByPageId[pageId]?.remotePageId ??
              null,
            addedPageId!
          ),
        { timeout: 30_000 }
      )
      .not.toBeNull()
    await nextFrame('t2')
    await expect
      .poll(() => drawnBrowserTabs(page, worktreeId), { timeout: 30_000 })
      .toEqual([
        {
          id: serverTab!.id,
          pages: [
            { id: firstPageId, url: `${origin}/a` },
            { id: addedPageId, url: `${origin}/b` }
          ]
        }
      ])
    // Held through a later frame, so the expectation is not a frame that has not arrived yet.
    await nextFrame('t3')
    await page.waitForTimeout(2_000)
    expect(await drawnBrowserTabs(page, worktreeId)).toHaveLength(1)
    expect((await drawnBrowserTabs(page, worktreeId))[0]!.pages).toHaveLength(2)

    await page.evaluate(
      (pageId) => window.__store!.getState().closeBrowserPage(pageId),
      addedPageId!
    )
    await nextFrame('t4')
    await expect
      .poll(() => drawnBrowserTabs(page, worktreeId), { timeout: 30_000 })
      .toEqual([{ id: serverTab!.id, pages: [{ id: firstPageId, url: `${origin}/a` }] }])
    await nextFrame('t5')
    await page.waitForTimeout(2_000)
    expect(await drawnBrowserTabs(page, worktreeId)).toEqual([
      { id: serverTab!.id, pages: [{ id: firstPageId, url: `${origin}/a` }] }
    ])
  } finally {
    await client.dispose()
    await host.dispose()
    server.close()
  }
})
