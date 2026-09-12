import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId } from './helpers/store'

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function startFedCmFallbackServer(): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const pathname = new URL(request.url ?? '/', origin).pathname
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (pathname === '/popup') {
      response.end(
        '<!doctype html><html><head><title>Popup fallback</title></head><body>Popup fallback<script>window.opener?.postMessage("popup-opener-live", window.location.origin)</script></body></html>'
      )
      return
    }
    response.end(`
      <!doctype html>
      <html>
        <head><title>FedCM fallback oracle</title></head>
        <body>
          <output id="capabilities"></output>
          <button id="sign-in">Sign in</button>
          <output id="path">pending</output>
          <script>
            const hasIdentityCredential = 'IdentityCredential' in window
            const hasIdentityProvider = 'IdentityProvider' in window
            window.popupMessages = []
            window.addEventListener('message', (event) => {
              window.popupMessages.push(event.data)
            })
            document.querySelector('#capabilities').textContent = JSON.stringify({
              hasIdentityCredential,
              hasIdentityProvider
            })
            document.querySelector('#sign-in').addEventListener('click', () => {
              if (hasIdentityCredential && hasIdentityProvider) {
                document.querySelector('#path').textContent = 'fedcm-selected'
                return
              }
              const popup = window.open('/popup', 'google-auth', 'width=480,height=640')
              document.querySelector('#path').textContent = popup ? 'popup-live' : 'popup-blocked'
            })
          </script>
        </body>
      </html>
    `)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/`, close: () => closeServer(server) }
}

test('embedded browser omits unusable FedCM and reaches the popup fallback', async ({
  electronApp,
  orcaPage
}) => {
  const server = await startFedCmFallbackServer()
  try {
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    expect(worktreeId).not.toBeNull()
    const browserTabId = await orcaPage.evaluate(
      ({ targetWorktreeId, url }) => {
        const tab = window.__store!.getState().createBrowserTab(targetWorktreeId!, url, {
          title: 'FedCM fallback oracle',
          activate: true
        })
        return tab.id
      },
      { targetWorktreeId: worktreeId, url: server.url }
    )
    const readGuest = async <T>(expression: string): Promise<T> =>
      orcaPage.evaluate(
        async ({ targetBrowserTabId, script }) => {
          const slot = document.querySelector(
            `[data-browser-overlay-tab-id="${targetBrowserTabId}"]`
          )
          const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
          if (!webview) {
            throw new Error(`Missing webview for browser tab ${targetBrowserTabId}`)
          }
          return (await webview.executeJavaScript(script)) as T
        },
        { targetBrowserTabId: browserTabId, script: expression }
      )

    await expect
      .poll(() => readGuest<string>('document.title'), { timeout: 10_000 })
      .toBe('FedCM fallback oracle')
    const capabilities = await readGuest<{
      hasIdentityCredential: boolean
      hasIdentityProvider: boolean
    }>('JSON.parse(document.querySelector("#capabilities").textContent)')
    expect.soft(capabilities).toEqual({
      hasIdentityCredential: false,
      hasIdentityProvider: false
    })

    await readGuest<void>('document.querySelector("#sign-in").click()')
    const path = await readGuest<string>('document.querySelector("#path").textContent')
    expect.soft(path).toBe('popup-live')
    await expect
      .poll(() =>
        electronApp.evaluate(async ({ webContents }) => {
          const popup = webContents.getAllWebContents().find((contents) => {
            return contents.getURL().endsWith('/popup')
          })
          if (!popup) {
            return null
          }
          return {
            openerLive: await popup.executeJavaScript('Boolean(window.opener)'),
            title: await popup.executeJavaScript('document.title'),
            url: popup.getURL()
          }
        })
      )
      .toEqual({
        openerLive: true,
        title: 'Popup fallback',
        url: `${server.url}popup`
      })
    await expect
      .poll(() => readGuest<string[]>('window.popupMessages'))
      .toEqual(['popup-opener-live'])
  } finally {
    await server.close()
  }
})
