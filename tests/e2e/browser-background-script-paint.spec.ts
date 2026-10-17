import WebSocket from 'ws'
import { createServer } from 'node:http'
import { expect, test } from './helpers/orca-app'
import { getActiveWorktreeId, switchToOtherWorktree, waitForActiveWorktree } from './helpers/store'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

const frame = `new Promise(resolve => {
  let done = false;
  requestAnimationFrame(() => { if (!done) { done = true; resolve(true); } });
  setTimeout(() => { if (!done) { done = true; resolve(false); } }, 1500);
})`

test('an inactive browser page can finish a frame-dependent script without focus', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const hostSession = await orcaPage.context().newCDPSession(orcaPage)
  await hostSession.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  // Playwright's defaults mask background scheduling failures in the guest.
  const flags = await electronApp.evaluate(({ app }) => {
    const names = [
      'disable-background-timer-throttling',
      'disable-backgrounding-occluded-windows',
      'disable-renderer-backgrounding'
    ]
    for (const name of names) {
      app.commandLine.removeSwitch(name)
    }
    return names.map((name) => app.commandLine.hasSwitch(name))
  })
  expect(flags).toEqual([false, false, false])
  const server = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><body><main id="login" hidden>Login fixture</main></body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  registerPostElectronShutdownCleanup(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing fixture port')
  }
  const url = `http://127.0.0.1:${address.port}/first`
  const laterUrl = `http://localhost:${address.port}/later`
  await waitForActiveWorktree(orcaPage)
  const worktree = await getActiveWorktreeId(orcaPage)
  if (!worktree) {
    throw new Error('Missing fixture worktree')
  }
  const created = await orcaPage.evaluate(
    async ({ worktree, url }) => {
      const response = await window.api.runtime.call({
        method: 'browser.tabCreate',
        params: { worktree: `id:${worktree}`, url }
      })
      if (
        !response.ok ||
        !response.result ||
        typeof response.result !== 'object' ||
        !('browserPageId' in response.result) ||
        typeof response.result.browserPageId !== 'string'
      ) {
        throw new Error('Browser creation failed')
      }
      return response.result.browserPageId
    },
    { worktree, url }
  )
  let guestId = await electronApp.evaluate(({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((entry) => entry.getURL() === url)
    if (!guest) {
      throw new Error('Missing fixture guest')
    }
    return guest.id
  }, url)
  const sample = () =>
    electronApp.evaluate(
      async ({ webContents }, { guestId, expression }) => {
        const guest = webContents.fromId(guestId)
        if (!guest) {
          throw new Error('Fixture guest disappeared')
        }
        return guest.executeJavaScript(expression)
      },
      { guestId, expression: frame }
    )
  expect(await sample()).toBe(true)
  const getEndpoint = () =>
    orcaPage.evaluate(async (page) => {
      const response = await window.api.runtime.call({
        method: 'browser.exec',
        params: { page, command: 'get cdp-url' }
      })
      if (
        !response.ok ||
        !response.result ||
        typeof response.result !== 'object' ||
        !('cdpUrl' in response.result) ||
        typeof response.result.cdpUrl !== 'string'
      ) {
        throw new Error('Missing CDP endpoint')
      }
      return response.result.cdpUrl
    }, created)
  expect(await switchToOtherWorktree(orcaPage, worktree)).not.toBeNull()
  await new Promise((resolve) => setTimeout(resolve, 11_000))
  const swap = await electronApp.evaluate(
    async ({ webContents }, { guestId, laterUrl }) => {
      const guest = webContents.fromId(guestId)
      if (!guest) {
        throw new Error('Missing source guest')
      }
      const before = guest.getOSProcessId()
      await guest.loadURL(laterUrl)
      return { before, after: guest.getOSProcessId(), guestId: guest.id }
    },
    { guestId, laterUrl }
  )
  guestId = swap.guestId
  expect(swap.after).not.toBe(swap.before)
  const endpoint = await getEndpoint()
  const layout = await orcaPage.evaluate((pageId) => {
    const element = document.querySelector(`[data-browser-page-viewport-id="${pageId}"]`)
    return {
      present: !!element,
      rectangles: element?.getClientRects().length,
      display: element ? getComputedStyle(element).display : null
    }
  }, created)
  expect(layout.display).toBe('none')
  expect(layout.rectangles).toBe(0)
  expect(await sample()).toBe(false)
  await electronApp.evaluate(async ({ webContents }, guestId) => {
    await webContents
      .fromId(guestId)
      ?.executeJavaScript(
        "requestAnimationFrame(() => { document.querySelector('#login').hidden = false }); true"
      )
  }, guestId)
  const client = new WebSocket(endpoint)
  const reply = (id: number) =>
    new Promise<{ id: number; result?: { result?: { objectId?: string; value?: unknown } } }>(
      (resolve) => {
        const onMessage = (data: WebSocket.RawData) => {
          const response = JSON.parse(data.toString())
          if (response.id === id) {
            client.off('message', onMessage)
            resolve(response)
          }
        }
        client.on('message', onMessage)
      }
    )
  try {
    await new Promise<void>((resolve) => client.once('open', resolve))
    const response = reply(1)
    client.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: frame, awaitPromise: true, returnByValue: true }
      })
    )
    expect(await response).toMatchObject({ id: 1, result: { result: { value: true } } })
    const contextReply = reply(2)
    client.send(
      JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression: 'globalThis', returnByValue: false }
      })
    )
    const objectId = (await contextReply).result?.result?.objectId
    expect(typeof objectId).toBe('string')
    const visible = reply(3)
    client.send(
      JSON.stringify({
        id: 3,
        method: 'Runtime.callFunctionOn',
        params: {
          functionDeclaration: "function () { return !document.querySelector('#login').hidden }",
          objectId,
          returnByValue: true
        }
      })
    )
    expect(await visible).toMatchObject({ id: 3, result: { result: { value: true } } })
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null)
    ).toBe(true)
  } finally {
    client.close()
  }
  await expect
    .poll(() =>
      orcaPage.evaluate((pageId) => {
        const element = document.querySelector(`[data-browser-page-viewport-id="${pageId}"]`)
        return {
          rectangles: element?.getClientRects().length,
          display: element ? getComputedStyle(element).display : null
        }
      }, created)
    )
    .toEqual({ rectangles: 0, display: 'none' })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling()
    )
  ).toBe(true)
})
