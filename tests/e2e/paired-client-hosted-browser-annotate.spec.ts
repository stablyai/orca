// Remote workspace pages render on this desktop, so they must offer the same element annotation as local pages.

import { createServer } from 'node:http'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const PAGE_HTML =
  '<!doctype html><title>Annotate probe</title>' +
  '<button id="target" style="position:absolute;left:40px;top:40px;width:240px;height:80px">Target</button>'

test('annotates an element on a client-hosted page of a paired host', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  // Launches a second paired client app and waits for its runtime to adopt the repo.
  test.setTimeout(240_000)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(PAGE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Probe server did not bind a TCP port')
  }
  const url = `http://127.0.0.1:${address.port}/`
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'client-hosted annotate')
  try {
    const page = client.page
    await expect
      .poll(
        () =>
          page.evaluate(
            (root) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.path === root),
            testRepoPath
          ),
        { timeout: 120_000 }
      )
      .toBe(true)
    await page.evaluate(
      ({ root, environmentId }) => {
        const state = window.__store!.getState()
        const worktree = state.allWorktrees().find((candidate) => candidate.path === root)!
        state.setActiveWorktree(worktree.id, `runtime:${environmentId}`)
      },
      { root: testRepoPath, environmentId: client.environmentId }
    )
    await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
    const input = page.getByRole('combobox', {
      name: 'Search open tabs, history, files, URLs, agents…',
      exact: true
    })
    await input.fill(url)
    await input.press('Enter')

    const found: { pageId: string | null } = { pageId: null }
    await expect
      .poll(
        async () =>
          (found.pageId = await page.evaluate((targetUrl) => {
            const state = window.__store!.getState()
            const browserPage = Object.values(state.browserPagesByWorkspace)
              .flat()
              .find((candidate) => candidate.url === targetUrl)
            if (!browserPage) {
              return null
            }
            const handle = state.remoteBrowserPageHandlesByPageId[browserPage.id]
            return handle?.placement?.kind === 'client' ? browserPage.id : null
          }, url)),
        { timeout: 60_000 }
      )
      .not.toBeNull()
    const clientPageId = found.pageId
    if (!clientPageId) {
      throw new Error('The client-hosted page never registered')
    }

    const annotate = page.getByRole('button', { name: 'Annotate page element', exact: true })
    await expect(page.getByRole('button', { name: 'Grab page element', exact: true })).toBeEnabled()
    await expect(annotate).toBeEnabled({ timeout: 30_000 })
    await annotate.click()

    // Pick the element with real input on the guest, as a user click would.
    await expect
      .poll(() =>
        client.app.evaluate(async ({ webContents }, targetUrl) => {
          const guest = webContents.getAllWebContents().find((c) => c.getURL() === targetUrl)
          return guest?.executeJavaScript('typeof window.__orcaGrab?.cancelAwait')
        }, url)
      )
      .toBe('function')
    // CDP input is trusted and reaches a hidden window's guest without focusing it.
    await client.app.evaluate(async ({ webContents }, targetUrl) => {
      const guest = webContents.getAllWebContents().find((c) => c.getURL() === targetUrl)!
      guest.debugger.attach('1.3')
      try {
        const mouse = (type: string, extra: Record<string, unknown> = {}) =>
          guest.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: 160, y: 80, ...extra })
        await mouse('mouseMoved')
        await mouse('mousePressed', { button: 'left', clickCount: 1 })
        await mouse('mouseReleased', { button: 'left', clickCount: 1 })
      } finally {
        guest.debugger.detach()
      }
    }, url)

    const comment = page.getByPlaceholder('Describe what the agent should change here...')
    await expect(comment).toBeVisible({ timeout: 20_000 })
    await comment.fill('Make the target larger')
    await page.getByRole('button', { name: /^Add(?! project)/ }).click()
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window
              .__store!.getState()
              .browserAnnotationsByPageId[id]?.map((note) => note.payload.target.selector) ?? [],
          clientPageId
        )
      )
      .toEqual([expect.stringContaining('target')])
    await page.screenshot({ path: testInfo.outputPath('client-hosted-annotation.png') })
  } finally {
    await client.dispose()
    server.closeAllConnections()
    server.close()
  }
})
