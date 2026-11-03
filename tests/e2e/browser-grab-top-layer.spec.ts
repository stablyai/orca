// #28657: Grab must pick elements in the top layer (modal dialogs, popovers) opened after it arms.

import { createServer, type Server } from 'node:http'
import { evalInPage, rpc } from './helpers/browser-agent-focus-scenarios'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'

const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Grab top layer probe</title></head>
  <body>
    <dialog id="dialog"><button id="in-dialog" style="width:200px;height:60px">In dialog</button></dialog>
    <div id="popover" popover="auto"><button id="in-popover" style="width:200px;height:60px">In popover</button></div>
    <script>
      window.__presses = 0
      addEventListener('mousedown', () => { window.__presses += 1 })
    </script>
  </body>
</html>`

async function startProbeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(PAGE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Probe server did not bind a TCP port')
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Close keep-alive sockets or Windows server.close waits until the suite times out.
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

test.describe('browser grab over top-layer content', () => {
  let server: Awaited<ReturnType<typeof startProbeServer>>
  let pageId: string

  test.beforeEach(async ({ orcaPage }) => {
    server = await startProbeServer()
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    expect(worktreeId).toBeTruthy()
    const created = await orcaPage.evaluate(
      ({ targetWorktreeId, targetUrl }) =>
        window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
          title: 'Grab top layer probe',
          activate: true
        })?.activePageId ?? null,
      { targetWorktreeId: worktreeId!, targetUrl: server.url }
    )
    if (!created) {
      throw new Error('Failed to create the probe browser page')
    }
    pageId = created
    await expect
      .poll(() => evalInPage(orcaPage, pageId, 'document.readyState + window.__presses'), {
        timeout: 20_000
      })
      .toBe('complete0')
  })

  test.afterEach(async () => {
    await server.close()
  })

  // The dialog makes everything outside it inert; clicking outside an auto popover light-dismisses it.
  for (const { name, open, isOpen, targetId } of [
    {
      name: 'modal dialog',
      open: "document.getElementById('dialog').showModal()",
      isOpen: "String(document.getElementById('dialog').open)",
      targetId: 'in-dialog'
    },
    {
      name: 'popover',
      open: "document.getElementById('popover').showPopover()",
      isOpen: "String(document.getElementById('popover').matches(':popover-open'))",
      targetId: 'in-popover'
    }
  ]) {
    test(`picks an element inside a ${name} opened after grab arms`, async ({ orcaPage }) => {
      await expect(
        orcaPage.evaluate(
          (id) => window.api.browser.setGrabMode({ browserPageId: id, enabled: true }),
          pageId
        )
      ).resolves.toMatchObject({ ok: true })
      const [x, y] = String(
        await evalInPage(
          orcaPage,
          pageId,
          `${open}; (() => { const r = document.getElementById('${targetId}').getBoundingClientRect(); return (r.x + r.width / 2) + ',' + (r.y + r.height / 2) })()`
        )
      )
        .split(',')
        .map(Number)

      const selection = orcaPage.evaluate(
        (id) => window.api.browser.awaitGrabSelection({ browserPageId: id, opId: 'e2e-top-layer' }),
        pageId
      )
      await expect
        .poll(() => evalInPage(orcaPage, pageId, 'typeof window.__orcaGrab?.cancelAwait'))
        .toBe('function')
      await rpc(orcaPage, 'browser.mouseMove', { page: pageId, x: x - 4, y })
      await rpc(orcaPage, 'browser.mouseMove', { page: pageId, x, y })
      await rpc(orcaPage, 'browser.mouseDown', { page: pageId, button: 'left' })
      await rpc(orcaPage, 'browser.mouseUp', { page: pageId, button: 'left' })

      expect(await selection).toMatchObject({
        kind: 'selected',
        payload: { target: { selector: expect.stringContaining(targetId) } }
      })
      // The pick must not reach the page as a press or close what it picked from.
      expect(await evalInPage(orcaPage, pageId, 'window.__presses')).toBe('0')
      expect(await evalInPage(orcaPage, pageId, isOpen)).toBe('true')
    })
  }
})
