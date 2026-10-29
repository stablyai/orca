import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getBrowserTabs,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

function readTabLoading(page: Page, worktreeId: string, tabId: string): Promise<boolean | null> {
  return page.evaluate(
    ({ worktreeId, tabId }) => {
      const tab = window.__store
        ?.getState()
        .browserTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
      return tab?.loading ?? null
    },
    { worktreeId, tabId }
  )
}

test('shows Stop and the loading line during a held reload, then returns to Reload', async ({
  orcaPage
}, testInfo) => {
  let requestCount = 0
  const reloadResolvers: (() => void)[] = []
  let reloadReleased = false
  let reloadRequestSeen: (() => void) | undefined
  const secondRequest = new Promise<void>((resolve) => {
    reloadRequestSeen = resolve
  })
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname !== '/held') {
      response.writeHead(204).end()
      return
    }
    requestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (requestCount === 1) {
      response.end('<!doctype html><title>Held reload</title><body>initial</body>')
      return
    }
    reloadRequestSeen?.()
    const release = (): void => {
      response.end(`<!doctype html><title>Held reload</title><body>reloaded-${requestCount}</body>`)
    }
    if (reloadReleased) {
      release()
    } else {
      new Promise<void>((resolve) => reloadResolvers.push(resolve)).then(release)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/held`
  try {
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const tab = await orcaPage.evaluate(
      ({ worktreeId, url }) => {
        const created = window.__store?.getState().createBrowserTab(worktreeId, url, {
          title: 'Held reload',
          activate: true
        })
        return created ? { id: created.id, url: created.url } : null
      },
      { worktreeId, url }
    )
    if (!tab) {
      throw new Error('browser tab was not created')
    }
    const pane = orcaPage.locator(`[data-browser-overlay-tab-id="${tab.id}"]`)
    const reload = pane.getByRole('button', { name: 'Reload' })
    await expect(reload).toBeVisible({ timeout: 20_000 })
    await reload.click()
    await secondRequest
    await expect
      .poll(async () => (await getBrowserTabs(orcaPage, worktreeId)).at(-1)?.url, {
        timeout: 20_000
      })
      .toBe(url)
    const getLoading = (): Promise<boolean | null> => readTabLoading(orcaPage, worktreeId, tab.id)
    await expect.poll(getLoading, { timeout: 10_000 }).toBe(true)
    const stop = pane.getByRole('button', { name: 'Stop' })
    await expect(stop).toBeVisible({ timeout: 10_000 })
    await expect(pane.locator('[data-browser-load-progress="loading"]')).toHaveCount(1)
    await orcaPage.screenshot({ path: testInfo.outputPath('reload-held.png') })
    reloadReleased = true
    reloadResolvers.splice(0).forEach((resolve) => resolve())
    await expect(pane.getByRole('button', { name: 'Reload' })).toBeVisible({ timeout: 20_000 })
    await expect.poll(getLoading, { timeout: 10_000 }).toBe(false)
    const body = await pane
      .locator('webview')
      .evaluate((webview) =>
        (webview as Electron.WebviewTag).executeJavaScript('document.body.textContent')
      )
    expect(body).toContain('reloaded')
  } finally {
    reloadReleased = true
    reloadResolvers.splice(0).forEach((resolve) => resolve())
    await closeServer(server)
  }
})

test('shows loading while a link inside the page waits on the server', async ({ orcaPage }) => {
  let releaseHeld: (() => void) | undefined
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (pathname === '/held') {
      releaseHeld = () => response.end('<!doctype html><title>Held</title><body>held</body>')
      return
    }
    response.end('<!doctype html><title>Start</title><body><a href="/held">next</a></body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('held-link server has no port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  try {
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const tabId = await orcaPage.evaluate(
      ({ worktreeId, url }) =>
        window.__store?.getState().createBrowserTab(worktreeId, url, { activate: true })?.id ??
        null,
      { worktreeId, url: `${origin}/` }
    )
    if (!tabId) {
      throw new Error('browser tab was not created')
    }
    const pane = orcaPage.locator(`[data-browser-overlay-tab-id="${tabId}"]`)
    const getLoading = (): Promise<boolean | null> => readTabLoading(orcaPage, worktreeId, tabId)
    await expect(pane.getByRole('button', { name: 'Reload' })).toBeVisible({ timeout: 20_000 })
    await expect.poll(getLoading, { timeout: 10_000 }).toBe(false)

    await pane
      .locator('webview')
      .evaluate((webview: Electron.WebviewTag) =>
        webview.executeJavaScript('document.querySelector("a").click()')
      )
    await expect.poll(() => releaseHeld !== undefined, { timeout: 10_000 }).toBe(true)
    await expect.poll(getLoading, { timeout: 10_000 }).toBe(true)
    await expect(pane.locator('[data-browser-load-progress="loading"]')).toHaveCount(1)

    releaseHeld?.()
    await expect.poll(getLoading, { timeout: 10_000 }).toBe(false)
    await expect(pane.locator('[data-browser-load-progress="loading"]')).toHaveCount(0)
  } finally {
    releaseHeld?.()
    await closeServer(server)
  }
})
