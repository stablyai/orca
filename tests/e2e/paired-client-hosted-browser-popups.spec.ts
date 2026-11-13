import { createServer, type Server } from 'node:http'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { waitForPairedClientWorktree } from './helpers/paired-client-host-session'
import { readHostBrowserPageUrls } from './helpers/host-session-tabs'

// A This-device page opens target=_blank links as This-device tabs and keeps OAuth popups attached to their opener.

const OPENER_HTML = `<!doctype html><title>Opener</title>
<style>body{margin:0}a,button{display:block;width:300px;height:60px;margin:10px}</style>
<a id="blank" href="/destination" target="_blank">blank link</a>
<button id="oauth" onclick="startOauth()">sign in</button>
<script>
window.__oauthMessages = []
addEventListener('message', (event) => window.__oauthMessages.push(String(event.data)))
function startOauth() {
  const redirect = encodeURIComponent(location.origin + '/callback')
  window.__oauthPopup = window.open('/authorize?client_id=e2e&redirect_uri=' + redirect + '&response_type=code', 'oauth', 'popup,width=480,height=640')
}
</script>`

const CALLBACK_HTML = `<!doctype html><title>Callback</title><script>
window.opener.postMessage('code=abc', '*')
setTimeout(() => window.close(), 100)
</script>`

async function startFixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (path === '/opener') {
      response.end(OPENER_HTML)
    } else if (path === '/authorize') {
      response.end(`<script>location.replace('/callback?code=abc')</script>`)
    } else if (path === '/callback') {
      response.end(CALLBACK_HTML)
    } else {
      response.end('<!doctype html><title>Destination</title>')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('fixture server has no port')
  }
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

function readPagePlacements(page: Page, worktreeId: string): Promise<Record<string, string>> {
  return page.evaluate((worktreeId) => {
    const state = window.__store!.getState()
    const placements: Record<string, string> = {}
    for (const workspace of state.browserTabsByWorktree[worktreeId] ?? []) {
      for (const browserPage of state.browserPagesByWorkspace[workspace.id] ?? []) {
        const kind = state.remoteBrowserPageHandlesByPageId[browserPage.id]?.placement?.kind
        placements[new URL(browserPage.url).pathname] = kind ?? 'none'
      }
    }
    return placements
  }, worktreeId)
}

async function showPage(page: Page, worktreeId: string, path: string): Promise<void> {
  await page.evaluate(
    ({ worktreeId, path }) => {
      const state = window.__store!.getState()
      for (const workspace of state.browserTabsByWorktree[worktreeId] ?? []) {
        for (const browserPage of state.browserPagesByWorkspace[workspace.id] ?? []) {
          if (new URL(browserPage.url).pathname === path) {
            state.focusBrowserTabInWorktree(worktreeId, browserPage.id, { surfacePane: true })
          }
        }
      }
    },
    { worktreeId, path }
  )
}

function guestEval(client: PairedElectronClient, url: string, code: string): Promise<unknown> {
  return client.app.evaluate(
    ({ webContents }, { url, code }) =>
      webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === 'webview' && contents.getURL() === url)
        ?.executeJavaScript(code) ?? null,
    { url, code }
  )
}

// A real mouse click, so main sees the user's gesture as it would on a desktop.
async function clickInGuest(
  client: PairedElectronClient,
  url: string,
  selector: string
): Promise<void> {
  await expect
    .poll(() => guestEval(client, url, 'innerWidth > 320 && innerHeight > 200'), {
      timeout: 30_000
    })
    .toBe(true)
  await client.app.evaluate(
    async ({ webContents }, { url, selector }) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === 'webview' && contents.getURL() === url)!
      const { x, y }: { x: number; y: number } = await guest.executeJavaScript(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
      )
      guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    },
    { url, selector }
  )
}

test('a This-device page opens new tabs on this device and keeps OAuth popups working', async ({
  testRepoPath
}, testInfo) => {
  // Boots a headless host and a paired client, then waits on two tab creations and a popup round trip.
  test.setTimeout(300_000)
  const { server, origin } = await startFixture()
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'This-device popups')
    const page = client.page
    const worktreeId = await waitForPairedClientWorktree(page)
    await page.evaluate(
      ({ environmentId, worktreeId }) =>
        window.__store!.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`),
      { environmentId: client.environmentId, worktreeId }
    )
    const openerUrl = `${origin}/opener`
    await page.evaluate(async (url) => {
      const state = window.__store!.getState()
      state.setBrowserDefaultUrl(url)
      await state.openNewBrowserTabInActiveWorkspace(
        state.activeGroupIdByWorktree[state.activeWorktreeId!]!
      )
    }, openerUrl)
    await expect
      .poll(() => readPagePlacements(page, worktreeId), { timeout: 60_000 })
      .toEqual({ '/opener': 'client' })
    await expect
      .poll(() => guestEval(client!, openerUrl, 'document.readyState'), { timeout: 60_000 })
      .toBe('complete')

    await showPage(page, worktreeId, '/opener')
    await clickInGuest(client, openerUrl, '#blank')
    await expect
      .poll(() => readPagePlacements(page, worktreeId), {
        timeout: 30_000,
        message: 'the target=_blank link did not open a This-device tab'
      })
      .toEqual({ '/opener': 'client', '/destination': 'client' })
    await expect
      .poll(() => readHostBrowserPageUrls(host.client, `path:${testRepoPath}`), { timeout: 30_000 })
      .toContain(`${origin}/destination`)

    await showPage(page, worktreeId, '/opener')
    await clickInGuest(client, openerUrl, '#oauth')
    await expect
      .poll(() => guestEval(client!, openerUrl, 'window.__oauthMessages.join()'), {
        timeout: 30_000,
        message: 'the OAuth popup never reached its opener'
      })
      .toBe('code=abc')
    await expect
      .poll(() => guestEval(client!, openerUrl, 'window.__oauthPopup.closed'), { timeout: 10_000 })
      .toBe(true)
  } finally {
    await client?.dispose()
    await host.dispose()
    server.close()
  }
})
