import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import { forceQuitElectronAppForE2E } from './helpers/electron-process-shutdown'
import { focusMaterializedRemoteBrowserPane } from './helpers/materialized-remote-browser-pane'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

// What this proves, live: a paired client SIGKILLed mid-screencast — no unsubscribe, no graceful
// socket close — can reopen on the same device identity and get a WORKING stream back, and the
// runtime is left holding exactly one subscriber for the page, never the dead client's as well.
// The page is server-placed, so a screencast is the only way pixels can reach the client at all.
//
// The runtime-side oracle is the guest page's own viewport. A screencast subscriber that declares a
// viewport size owns the page's device-metrics override while it is subscribed; when it leaves,
// ownership falls back to whatever subscriber is still registered, and the override is cleared
// outright when none is. So `innerWidth` read inside the runtime's guest page names WHICH
// subscriber the runtime still believes is watching — the fact under test, in one integer.
//
// Note on the ghost window: over a loopback pairing the kernel closes the dead client's socket at
// once, so the runtime usually drops the orphaned subscriber in well under a second and the
// same-device replacement never has to fire. That is recorded as evidence, not asserted, because
// the ghost this guards against belongs to transports that leave the socket half-open. The
// subtraction check at the end holds either way: whatever the runtime kept, it must not be the
// force-quit client's.

const ROUTE_COLORS = {
  '/server': { name: 'teal', rgb: [0, 128, 128] },
  '/next': { name: 'crimson', rgb: [220, 20, 60] }
} as const

// Deliberately far apart, and far from the guest's natural width, so the three states the runtime
// can be in (first client's viewport / rejoined client's viewport / no subscriber at all) are
// unmistakable in a single integer.
const FIRST_CLIENT_WINDOW = { width: 900, height: 700 }
const REJOINED_CLIENT_WINDOW = { width: 1600, height: 1040 }

type GhostBrowserFixture = {
  close(): Promise<void>
  origin: string
  serverUrl: string
  nextUrl: string
}

/**
 * Two solid, far-apart full-viewport colors. The client can only tell them apart by decoding a
 * frame it actually received, which is what makes "the screencast is live" checkable on screen
 * rather than by transport bookkeeping.
 */
async function startGhostBrowserFixture(): Promise<GhostBrowserFixture> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname === '/next' ? '/next' : '/server'
    const color = ROUTE_COLORS[route]
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    })
    response.end(`<!doctype html><html><head><title>${color.name}</title>
      <style>
        html,body{margin:0;padding:0;height:100%;background:rgb(${color.rgb.join(',')});}
        #tick{position:fixed;left:8px;top:8px;font:700 28px monospace;color:#fff;}
      </style></head><body>
      <div id="marker">${color.name}</div>
      <div id="tick">0</div>
      <script>
        let n = 0
        // Keeps the compositor producing paints, so a live screencast always has something to send.
        setInterval(() => { document.getElementById('tick').textContent = String(++n) }, 100)
      </script>
    </body></html>`)
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
    origin,
    serverUrl: `${origin}/server`,
    nextUrl: `${origin}/next`
  }
}

async function callEnvironment<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params,
        timeoutMs: 30_000
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  ) as Promise<TResult>
}

async function setClientWindowSize(
  app: ElectronApplication,
  bounds: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...bounds })
  }, bounds)
}

/**
 * The runtime's own answer to "who is watching this page": the device-metrics override a screencast
 * subscriber's viewport imposes on the guest, read from inside the guest itself.
 */
async function readGuestViewportWidth(
  app: ElectronApplication,
  originPrefix: string
): Promise<number | null> {
  return app.evaluate(async ({ webContents }, prefix) => {
    const target = webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix))
    if (!target) {
      return null
    }
    try {
      return (await target.executeJavaScript('innerWidth')) as number
    } catch {
      return null
    }
  }, originPrefix)
}

async function readGuestUrls(app: ElectronApplication, originPrefix: string): Promise<string[]> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .map((contents) => contents.getURL())
        .filter((url) => url.startsWith(prefix)),
    originPrefix
  )
}

async function waitForWorktreeId(page: Page): Promise<string> {
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees().length ?? 0), {
      timeout: 60_000,
      message: 'paired client never saw a host worktree'
    })
    .toBeGreaterThan(0)
  const worktreeId = await page.evaluate(
    () => window.__store?.getState().allWorktrees()[0]?.id ?? null
  )
  if (!worktreeId) {
    throw new Error('paired client did not receive the host worktree')
  }
  return worktreeId
}

/** Server placement only: a client-hosted page has no server screencast to ghost. */
async function forceServerPlacement(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__store?.getState().updateSettings({ browserClientHostedRemoteEnabled: false })
  })
}

type FrameSample = {
  src: string | null
  dominant: 'teal' | 'crimson' | 'other' | 'undecodable'
}

/**
 * Decodes the frame the pane is actually showing. The <img> src alone cannot tell a live stream
 * from a frozen one holding a stale object URL, and cannot say WHICH page is on screen. The pixels
 * can.
 */
async function sampleRenderedFrame(page: Page): Promise<FrameSample> {
  return page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('[data-testid="remote-browser-frame"]')
    if (!img) {
      return { src: null, dominant: 'undecodable' as const }
    }
    const src = img.getAttribute('src')
    try {
      if (!img.complete || img.naturalWidth === 0) {
        await img.decode()
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.min(img.naturalWidth, 160))
      canvas.height = Math.max(1, Math.min(img.naturalHeight, 160))
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) {
        return { src, dominant: 'undecodable' as const }
      }
      context.drawImage(img, 0, 0, canvas.width, canvas.height)
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      let red = 0
      let green = 0
      let blue = 0
      for (let i = 0; i < data.length; i += 4) {
        red += data[i]
        green += data[i + 1]
        blue += data[i + 2]
      }
      const pixels = data.length / 4
      const [r, g, b] = [red / pixels, green / pixels, blue / pixels]
      // Teal is green+blue with no red; crimson is red with neither.
      if (r > 90 && r > g + 50 && r > b + 50) {
        return { src, dominant: 'crimson' as const }
      }
      if (g > 40 && b > 40 && g + b > r * 2) {
        return { src, dominant: 'teal' as const }
      }
      return { src, dominant: 'other' as const }
    } catch {
      return { src, dominant: 'undecodable' as const }
    }
  })
}

async function expectPaneShows(
  page: Page,
  expected: 'teal' | 'crimson',
  message: string
): Promise<void> {
  await expect
    .poll(async () => (await sampleRenderedFrame(page)).dominant, {
      timeout: 90_000,
      intervals: [500, 1_000, 2_000],
      message
    })
    .toBe(expected)
}

async function attachEvidence(testInfo: TestInfo, name: string, body: unknown): Promise<void> {
  console.log(`[ghost-e2e] ${name}`, JSON.stringify(body))
  await testInfo.attach(name, {
    body: JSON.stringify(body, null, 2),
    contentType: 'application/json'
  })
}

test('replaces a force-quit client screencast subscriber when the same device rejoins', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  const fixture = await startGhostBrowserFixture()
  let client: PairedElectronClient | null = null
  let abandonedProfile: string | null = null

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Ghost subscriber rejoin')
    const clientProfile = client.userDataDir
    abandonedProfile = clientProfile
    await setClientWindowSize(client.app, FIRST_CLIENT_WINDOW)
    const worktreeId = await waitForWorktreeId(client.page)
    await forceServerPlacement(client.page)

    const created = await callEnvironment<{ browserPageId: string }>(
      client.page,
      client.environmentId,
      'browser.tabCreate',
      { worktree: `id:${worktreeId}`, url: fixture.serverUrl, activate: true }
    )
    const remotePageId = created.browserPageId

    // The page really is on the runtime, not on the client.
    await expect
      .poll(() => readGuestUrls(host.app, fixture.origin), {
        timeout: 60_000,
        message: 'runtime never opened the server-placed browser page'
      })
      .toHaveLength(1)
    expect(await readGuestUrls(client.app, fixture.origin)).toHaveLength(0)

    // Unwatched width, before any subscriber imposes a viewport.
    await expect
      .poll(() => readGuestViewportWidth(host.app, fixture.origin), {
        timeout: 30_000,
        message: 'runtime guest page never reported a viewport'
      })
      .not.toBeNull()
    const unwatchedWidth = await readGuestViewportWidth(host.app, fixture.origin)

    // The client mirrors the host's tab on its own; opening that pane is the whole user path. A
    // second locally built pane for the same page would subscribe over this one — the runtime keeps
    // one screencast per connection — and the viewport fingerprint below would name the wrong pane.
    await focusMaterializedRemoteBrowserPane(client.page, {
      environmentId: client.environmentId,
      remotePageId,
      worktreeId
    })
    await expect(client.page.getByTestId('remote-browser-frame').first()).toBeVisible({
      timeout: 60_000
    })
    await expectPaneShows(client.page, 'teal', 'first client never rendered the server page pixels')

    // The first client is now the page's viewport owner, so the runtime is stamping ITS pane size
    // onto the guest — a per-subscriber fingerprint the rest of the test reads back.
    await expect
      .poll(() => readGuestViewportWidth(host.app, fixture.origin), {
        timeout: 60_000,
        message: 'first subscriber never took ownership of the guest viewport'
      })
      .not.toBe(unwatchedWidth)
    const firstClientWidth = await readGuestViewportWidth(host.app, fixture.origin)

    // Force-quit: SIGKILL the whole app, no unsubscribe, no dispose, no graceful close.
    const killedApp = client.app
    client = null
    await forceQuitElectronAppForE2E(killedApp)

    // What the runtime does with the orphaned subscriber while NO client exists at all. Recorded as
    // evidence: the socket may or may not be reaped in this window, and both are legitimate — the
    // assertion that matters is what the runtime does when the same device comes back.
    const orphanTimeline: { atMs: number; guestWidth: number | null }[] = []
    const killedAt = Date.now()
    for (const waitMs of [500, 1_500, 3_000, 5_000]) {
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      orphanTimeline.push({
        atMs: Date.now() - killedAt,
        guestWidth: await readGuestViewportWidth(host.app, fixture.origin)
      })
    }
    const orphanSurvivedTheKill = orphanTimeline.some(
      (entry) => entry.guestWidth === firstClientWidth
    )

    // Server placement means the page outlives the client that was viewing it — which is what
    // leaves a subscriber behind to be ghosted in the first place.
    expect(await readGuestUrls(host.app, fixture.origin)).toHaveLength(1)

    // Reopen the app on the SAME profile: same stored pairing credential, so the runtime
    // authenticates the same pairedDeviceId over a brand new socket.
    client = await launchPairedElectronClient(host.offer, testInfo, 'Ghost subscriber rejoin', {
      reuseUserDataDir: clientProfile
    })
    const widthWhenRejoiningClientStarted = await readGuestViewportWidth(host.app, fixture.origin)
    await setClientWindowSize(client.app, REJOINED_CLIENT_WINDOW)
    const rejoinedWorktreeId = await waitForWorktreeId(client.page)
    await forceServerPlacement(client.page)
    await focusMaterializedRemoteBrowserPane(client.page, {
      environmentId: client.environmentId,
      remotePageId,
      worktreeId: rejoinedWorktreeId
    })

    await expect(client.page.getByTestId('remote-browser-frame').first()).toBeVisible({
      timeout: 90_000
    })
    // Pixels the rejoined client decoded itself — not the dead client's last paint, which died with
    // its renderer.
    await expectPaneShows(
      client.page,
      'teal',
      'rejoined client never rendered a screencast frame of the surviving page'
    )

    // The rejoined device, on a different window size, is now the runtime's viewport owner.
    await expect
      .poll(() => readGuestViewportWidth(host.app, fixture.origin), {
        timeout: 60_000,
        message: 'rejoined subscriber never took ownership of the guest viewport'
      })
      .not.toBe(firstClientWidth)
    const rejoinedClientWidth = await readGuestViewportWidth(host.app, fixture.origin)
    expect(rejoinedClientWidth).not.toBe(unwatchedWidth)

    // The strongest on-screen proof that the stream is live rather than one stale snapshot: drive a
    // navigation from the runtime side and require the pane's pixels to follow it.
    await callEnvironment(client.page, client.environmentId, 'browser.goto', {
      worktree: `id:${rejoinedWorktreeId}`,
      page: remotePageId,
      url: fixture.nextUrl
    })
    await expectPaneShows(
      client.page,
      'crimson',
      'rejoined screencast never reflected a runtime-side navigation'
    )
    await expect
      .poll(() => readGuestUrls(host.app, fixture.origin), {
        timeout: 60_000,
        message: 'runtime page never navigated'
      })
      .toEqual([fixture.nextUrl])

    await client.page.screenshot({
      path: testInfo.outputPath('ghost-rejoin-live-frame.png'),
      fullPage: false
    })
    await testInfo.attach('rejoined-client-frame', {
      path: testInfo.outputPath('ghost-rejoin-live-frame.png'),
      contentType: 'image/png'
    })

    // Ghost replacement, checked by subtraction. Quit the rejoined client through the front door so
    // its own subscription unwinds cleanly, then ask the runtime who is left watching:
    //   - nobody: the device-metrics override is cleared and the guest returns to its unwatched
    //     width, which is only true if the force-quit client's subscriber is gone;
    //   - the force-quit client: its subscriber is still registered, inherits viewport ownership on
    //     the way out, and stamps ITS width back onto the guest.
    // A clean departure settles this in well under a second (measured), so the bounded window below
    // cannot be satisfied by the slow fallbacks — the 90-refusal sweep or the 15s heartbeat reap.
    const departingClient = client
    client = null
    await departingClient.dispose()

    const departure: { atMs: number; guestWidth: number | null }[] = []
    const departedAt = Date.now()
    for (;;) {
      const guestWidth = await readGuestViewportWidth(host.app, fixture.origin)
      departure.push({ atMs: Date.now() - departedAt, guestWidth })
      if (guestWidth !== rejoinedClientWidth || Date.now() - departedAt > 15_000) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    await attachEvidence(testInfo, 'ghost-subscriber-evidence', {
      unwatchedWidth,
      firstClientWidth,
      widthWhenRejoiningClientStarted,
      rejoinedClientWidth,
      orphanSurvivedTheKill,
      orphanTimeline,
      finalWidth: departure.at(-1)?.guestWidth,
      departureSamples: departure.length
    })

    const finalWidth = departure.at(-1)?.guestWidth
    expect(
      finalWidth,
      'the force-quit client still owned a screencast subscriber after the rejoining device replaced it'
    ).not.toBe(firstClientWidth)
    expect(finalWidth, 'the runtime never released the screencast viewport override').toBe(
      unwatchedWidth
    )
  } finally {
    await client?.dispose()
    if (abandonedProfile) {
      rmSync(abandonedProfile, { recursive: true, force: true })
    }
    await fixture.close()
    await host.dispose()
  }
})
