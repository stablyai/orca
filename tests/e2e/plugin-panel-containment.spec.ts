// Require zero loopback requests plus isolated-guest CSP/navigation containment and bounded bridge refusal.
// Chromium is required; keep experimental maturity until CI soak covers every desktop platform.

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  clickInGuest,
  evalInGuest,
  guestWebContentsId,
  pluginGuest,
  readGuestCsp,
  readInGuest,
  waitForGuestReady,
  ISOLATED_FRAMES_E2E
} from './helpers/plugin-frame-guest'

// Isolated frames are off by default; these journeys exercise the guest path.
test.use(ISOLATED_FRAMES_E2E)

type InstalledPanel = {
  pluginKey: string
  tabKey: string
  title: string
}

type ProbeServer = {
  origin: string
  requests: string[]
  close: () => Promise<void>
}

type GuestNavigationObservation = {
  willFrameNavigations: { defaultPrevented: boolean; isMainFrame: boolean; url: string }[]
  didFrameNavigations: string[]
  externalUrls: string[]
  /** Orca's "wants to open" prompts, answered from `promptAnswers` (default Cancel). */
  prompts: { message: string; detail: string; checkboxLabel: string }[]
  promptAnswers: { response: number; checkboxChecked: boolean }[]
}

type GuestDocumentSnapshot = {
  url: string
  marker: string | null
  fixture: boolean
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function startPermissiveProbeServer(): Promise<ProbeServer> {
  const requests: string[] = []
  const gif = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
  const server = createServer((request, response) => {
    requests.push(request.url ?? '/')
    response.setHeader('Access-Control-Allow-Origin', '*')
    if (request.url?.includes('beacon.gif')) {
      response.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': gif.byteLength })
      response.end(gif)
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('permissive probe response')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeServer(server)
  }
}

async function materializeHostilePlugin(origin: string): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-hostile-panel-e2e-'))
  const pluginRoot = join(tempRoot, 'hostile-panel')
  await cp(
    join(process.cwd(), 'examples', 'plugins', 'test-fixtures', 'hostile-panel'),
    pluginRoot,
    {
      recursive: true
    }
  )
  const panelPath = join(pluginRoot, 'panel.html')
  const panelHtml = await readFile(panelPath, 'utf8')
  await writeFile(panelPath, panelHtml.replaceAll('https://example.com', origin))
  return pluginRoot
}

async function installApprovedPanel(page: Page, sourcePath: string): Promise<InstalledPanel> {
  return page.evaluate(async (pluginPath) => {
    const settings = await window.api.settings.set({ pluginSystemEnabled: true })
    window.__store?.setState({ settings })
    await window.api.plugins.refresh()
    const installed = await window.api.plugins.install({ kind: 'local-path', path: pluginPath })
    if (!installed.ok) {
      throw new Error(installed.error)
    }
    const listed = await window.api.plugins.refresh()
    const plugin = listed.find((entry) => entry.pluginKey === installed.pluginKey)
    if (!plugin?.consentFingerprint || !plugin.panels[0]) {
      throw new Error(`installed plugin ${installed.pluginKey} has no reviewable panel`)
    }
    const approved = await window.api.plugins.consent({
      pluginKey: plugin.pluginKey,
      reviewedFingerprint: plugin.consentFingerprint,
      decision: 'approve'
    })
    const approvedPlugin = approved.find((entry) => entry.pluginKey === plugin.pluginKey)
    const panel = approvedPlugin?.panels[0]
    if (!panel) {
      throw new Error(`approved plugin ${plugin.pluginKey} has no panel`)
    }
    return { pluginKey: plugin.pluginKey, tabKey: panel.tabKey, title: panel.title }
  }, sourcePath)
}

async function openPanel(page: Page, panel: InstalledPanel): Promise<Locator> {
  await page.evaluate(async () => {
    const store = window.__store?.getState()
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    if (!store.rightSidebarOpen) {
      store.toggleRightSidebar()
    }
    // Refresh after the sidebar subscription exists so this isolated profile
    // cannot miss the install/consent change events emitted just before mount.
    await window.api.plugins.refresh()
  })
  const panelButton = page.getByRole('button', { name: panel.title })
  await expect(panelButton).toBeVisible({ timeout: 15_000 })
  await panelButton.click()
  const guest = pluginGuest(page, panel.title)
  await expect(guest).toBeVisible({ timeout: 15_000 })
  await waitForGuestReady(guest)
  return guest
}

async function attachProbeRequests(testInfo: TestInfo, requests: readonly string[]): Promise<void> {
  await testInfo.attach('hostile-panel-loopback-requests', {
    body: Buffer.from(JSON.stringify(requests, null, 2)),
    contentType: 'application/json'
  })
}

// Watches the guest WebContents itself: main's own will-frame-navigate guard runs first.
async function startGuestObserver(
  electronApp: ElectronApplication,
  guestId: number
): Promise<void> {
  await electronApp.evaluate(({ dialog, shell, webContents }, id) => {
    // By id: earlier specs in this worker may leave other plugins' guests alive.
    const guest = webContents.fromId(id)
    if (!guest) {
      throw new Error('plugin guest WebContents not found')
    }
    const observation: GuestNavigationObservation = {
      willFrameNavigations: [],
      didFrameNavigations: [],
      externalUrls: [],
      prompts: [],
      promptAnswers: []
    }
    const onWill = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
      observation.willFrameNavigations.push({
        defaultPrevented: event.defaultPrevented,
        isMainFrame: event.isMainFrame,
        url: event.url
      })
    }
    const onDid = (_event: Electron.Event, url: string) => {
      observation.didFrameNavigations.push(url)
    }
    const originalOpenExternal = shell.openExternal
    const originalShowMessageBox = dialog.showMessageBox
    // Never a native prompt on the test machine: record it and answer from the queue.
    const recordPrompt = async (...args: unknown[]): Promise<Electron.MessageBoxReturnValue> => {
      const options = args.at(-1)
      const field = (name: string): string =>
        typeof options === 'object' && options !== null && name in options
          ? String(Object.getOwnPropertyDescriptor(options, name)?.value)
          : ''
      observation.prompts.push({
        message: field('message'),
        detail: field('detail'),
        checkboxLabel: field('checkboxLabel')
      })
      return { ...(observation.promptAnswers.shift() ?? { response: 1, checkboxChecked: false }) }
    }
    dialog.showMessageBox = recordPrompt
    const recordOpenExternal = async (url: string): Promise<void> => {
      observation.externalUrls.push(url)
    }
    guest.on('will-frame-navigate', onWill)
    guest.on('did-frame-navigate', onDid)
    shell.openExternal = recordOpenExternal
    if (shell.openExternal !== recordOpenExternal) {
      throw new Error('shell.openExternal could not be stubbed')
    }
    Reflect.set(globalThis, '__orcaGuestProbe', {
      observation,
      dispose: () => {
        guest.off('will-frame-navigate', onWill)
        guest.off('did-frame-navigate', onDid)
        shell.openExternal = originalOpenExternal
        dialog.showMessageBox = originalShowMessageBox
      }
    })
  }, guestId)
}

async function readGuestObserver(
  electronApp: ElectronApplication
): Promise<GuestNavigationObservation> {
  const observation: GuestNavigationObservation = await electronApp.evaluate(
    () =>
      Object.getOwnPropertyDescriptor(globalThis, '__orcaGuestProbe')?.value?.observation ?? null
  )
  return observation
}

async function stopGuestObserver(
  electronApp: ElectronApplication
): Promise<GuestNavigationObservation | null> {
  const observation: GuestNavigationObservation | null = await electronApp.evaluate(() => {
    const probe = Object.getOwnPropertyDescriptor(globalThis, '__orcaGuestProbe')?.value
    probe?.dispose()
    Reflect.deleteProperty(globalThis, '__orcaGuestProbe')
    return probe?.observation ?? null
  })
  return observation
}

async function readGuestDocument(guest: Locator): Promise<GuestDocumentSnapshot> {
  const url = await guest.evaluate((webview: Electron.WebviewTag) => webview.getURL())
  const content = await evalInGuest<{ marker: string | null; fixture: boolean }>(
    guest,
    `({ marker: document.documentElement.dataset.navigationProbeDocument ?? null,
        fixture: document.querySelector('h1')?.textContent === 'Hostile panel fixture' })`
  )
  return { url, ...content }
}

function readProbe(guest: Locator, probe: string): Promise<string | null> {
  return readInGuest<string | null>(
    guest,
    `document.querySelector('[data-probe="${probe}"]')?.dataset.contained ?? null`
  )
}

test('contains hostile panel network and navigation probes', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  testInfo.annotations.push({ type: 'maturity', description: 'experimental' })
  const server = await startPermissiveProbeServer()
  const pluginRoot = await materializeHostilePlugin(server.origin)
  const tempRoot = join(pluginRoot, '..')
  const appUrl = orcaPage.url()
  const guestDocuments: GuestDocumentSnapshot[] = []
  let observation: GuestNavigationObservation | null = null
  let observing = false
  try {
    const panel = await installApprovedPanel(orcaPage, pluginRoot)
    const guest = await openPanel(orcaPage, panel)

    await expect(guest).toHaveAttribute('partition', /^persist:orca-plugin-[0-9a-f]{16}$/)
    await expect(orcaPage.locator(`iframe[title="${panel.title}"]`)).toHaveCount(0)
    expect(await readGuestCsp(guest)).toMatch(/connect-src 'self' data: blob:.*frame-src 'none'/)

    for (const probe of ['fetch-exfil', 'img-beacon']) {
      await expect.poll(() => readProbe(guest, probe), { timeout: 5_000 }).toBe('true')
    }

    const bridgeErrorCode = await evalInGuest<string>(
      guest,
      `window.orca.host.call('invalid.hostileAction', {}).then(
        () => 'unexpected_success',
        (error) => (typeof error?.code === 'string' ? error.code : 'missing_error_code'))`
    )
    // Why the host's code: the renderer checks only the shape, the host gates the method.
    expect(bridgeErrorCode).toBe('unknown_method')
    expect(server.requests).toEqual([])
    expect(orcaPage.url()).toBe(appUrl)

    await startGuestObserver(electronApp, await guestWebContentsId(guest))
    observing = true
    const initial = await readGuestDocument(guest)
    guestDocuments.push(initial)
    expect(initial.url).toMatch(/^orca-plugin-frame:\/\/[0-9a-f]{16}\//)
    for (const navigation of [
      { button: 'navigate-top', probe: 'top-navigation' },
      { button: 'navigate-self', probe: 'self-navigation' },
      { button: 'navigate-anchor-form', probe: 'anchor-form-navigation' },
      { button: 'navigate-meta', probe: 'meta-refresh-navigation' }
    ]) {
      const documentId = `source:${navigation.probe}`
      await evalInGuest(
        guest,
        `document.documentElement.dataset.navigationProbeDocument = ${JSON.stringify(documentId)};
        document.getElementById(${JSON.stringify(navigation.button)}).click()`
      )
      // Each probe reports after its attempt; a guest is its own top, so top-navigation's
      // `window.top !== window` verdict is meaningless here and the URL check decides.
      await expect.poll(() => readProbe(guest, navigation.probe)).not.toBeNull()
      const current = await readGuestDocument(guest)
      guestDocuments.push(current)
      expect(current).toEqual({ url: initial.url, marker: documentId, fixture: true })
      expect(server.requests).toEqual([])
      expect(orcaPage.url()).toBe(appUrl)
    }

    const guardDestination = `${server.origin}/frame-guard-navigation`
    await evalInGuest(guest, `location.assign(${JSON.stringify(guardDestination)})`)
    await expect
      .poll(async () => {
        observation = await readGuestObserver(electronApp)
        const attempt = observation.willFrameNavigations.find(({ url }) => url === guardDestination)
        return attempt?.defaultPrevented === true && attempt.isMainFrame
      })
      .toBe(true)
    const guarded = await readGuestDocument(guest)
    guestDocuments.push(guarded)
    expect(guarded).toEqual({
      url: initial.url,
      marker: 'source:meta-refresh-navigation',
      fixture: true
    })

    observation = await readGuestObserver(electronApp)
    const attempted = observation.willFrameNavigations.filter(({ url }) =>
      url.startsWith(server.origin)
    )
    expect(attempted.every(({ defaultPrevented }) => defaultPrevented)).toBe(true)
    expect(observation.didFrameNavigations.filter((url) => url.startsWith(server.origin))).toEqual(
      []
    )
    expect(observation.externalUrls).toEqual([])
    expect(server.requests).toEqual([])
    expect(orcaPage.url()).toBe(appUrl)

    // Bridge budgets on the guest path: oversized and flooded calls get real refusals.
    await clickInGuest(guest, '#bridge')
    for (const probe of ['oversized-message', 'message-flood']) {
      await expect
        .poll(() =>
          readInGuest<string | null>(
            guest,
            `document.querySelector('[data-probe="${probe}"]')?.dataset.contained ?? null`
          )
        )
        .toBe('true')
    }
  } finally {
    try {
      if (observing) {
        observation = await stopGuestObserver(electronApp)
      }
    } finally {
      await attachProbeRequests(testInfo, server.requests)
      await testInfo.attach('hostile-panel-guest-documents', {
        body: Buffer.from(JSON.stringify(guestDocuments, null, 2)),
        contentType: 'application/json'
      })
      await testInfo.attach('hostile-panel-guest-navigation-observation', {
        body: Buffer.from(JSON.stringify(observation, null, 2)),
        contentType: 'application/json'
      })
      await server.close()
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
})

test('shell.openExternal from a panel needs a real gesture in the guest', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  testInfo.annotations.push({ type: 'maturity', description: 'experimental' })
  const server = await startPermissiveProbeServer()
  const pluginRoot = await materializeHostilePlugin(server.origin)
  const tempRoot = join(pluginRoot, '..')
  const target = 'https://example.com/orca-open-external-probe'
  let observing = false
  try {
    const panel = await installApprovedPanel(orcaPage, pluginRoot)
    const guest = await openPanel(orcaPage, panel)
    await startGuestObserver(electronApp, await guestWebContentsId(guest))
    observing = true

    const ungated = await evalInGuest<string>(
      guest,
      `window.orca.shell.openExternal(${JSON.stringify(target)}).then(
        () => 'opened', (error) => String(error?.code))`
    )
    expect(ungated).toBe('not_permitted')
    expect((await readGuestObserver(electronApp)).externalUrls).toEqual([])

    await evalInGuest(
      guest,
      `(() => {
        const button = document.createElement('button')
        button.id = 'open-external'
        button.textContent = 'Open external'
        button.style.cssText = 'position:fixed;top:0;left:0;width:160px;height:40px;z-index:9'
        button.onclick = () => window.orca.shell.openExternal(${JSON.stringify(target)}).then(
          (result) => { window.__openExternal = result.opened ? 'opened' : result.reason },
          (error) => { window.__openExternal = String(error?.code) })
        document.body.appendChild(button)
      })()`
    )
    // A scripted click is not a gesture: the same handler must be refused.
    await evalInGuest(guest, `document.getElementById('open-external').click()`)
    await expect
      .poll(() => readInGuest<string | null>(guest, 'window.__openExternal ?? null'))
      .toBe('not_permitted')
    expect((await readGuestObserver(electronApp)).externalUrls).toEqual([])
    expect((await readGuestObserver(electronApp)).prompts).toEqual([])

    const clickAndRead = async (): Promise<string | null> => {
      await evalInGuest(guest, 'window.__openExternal = null')
      await clickInGuest(guest, '#open-external')
      await expect
        .poll(() => readInGuest<string | null>(guest, 'window.__openExternal ?? null'))
        .not.toBeNull()
      return readInGuest<string | null>(guest, 'window.__openExternal ?? null')
    }
    // This background launch's window is hidden, so nobody could answer a prompt: it settles at
    // once, unopened, instead of waiting forever.
    expect(await clickAndRead()).toBe('consent-unavailable')
    expect((await readGuestObserver(electronApp)).prompts).toEqual([])
    // Report the window as on screen (it is never shown) so the prompt path runs.
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.isVisible = () => true
        window.isMinimized = () => false
      }
    })

    // A real click on a host this plugin was never allowed asks first; Cancel opens nothing.
    expect(await clickAndRead()).toBe('cancelled')
    let observed = await readGuestObserver(electronApp)
    expect(observed.externalUrls).toEqual([])
    expect(observed.prompts).toEqual([
      {
        message: expect.stringContaining('wants to open example.com'),
        detail: target,
        checkboxLabel: expect.stringContaining('example.com')
      }
    ])
    // Open with "Always allow": opened now, and the next click opens without asking.
    await electronApp.evaluate(() => {
      Object.getOwnPropertyDescriptor(
        globalThis,
        '__orcaGuestProbe'
      )?.value?.observation.promptAnswers.push({ response: 0, checkboxChecked: true })
    })
    expect(await clickAndRead()).toBe('opened')
    expect(await clickAndRead()).toBe('opened')
    observed = await readGuestObserver(electronApp)
    expect(observed.externalUrls).toEqual([target, target])
    expect(observed.prompts).toHaveLength(2)
  } finally {
    if (observing) {
      await stopGuestObserver(electronApp)
    }
    await server.close()
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('detects and suspends a busy-looping panel in an isolated renderer', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  testInfo.annotations.push({ type: 'maturity', description: 'experimental' })
  const server = await startPermissiveProbeServer()
  const pluginRoot = await materializeHostilePlugin(server.origin)
  const tempRoot = join(pluginRoot, '..')
  const appUrl = orcaPage.url()
  let processes: { main: number | null; guest: number | null; guestUrl: string | null } | null =
    null
  try {
    const panel = await installApprovedPanel(orcaPage, pluginRoot)
    const guest = await openPanel(orcaPage, panel)

    const guestId = await guestWebContentsId(guest)
    processes = await electronApp.evaluate(
      ({ BrowserWindow, webContents }, { expectedUrl, id }) => {
        const mainContents = (
          BrowserWindow.getAllWindows().find(
            (candidate) => candidate.webContents.getURL() === expectedUrl
          ) ?? BrowserWindow.getAllWindows()[0]
        )?.webContents
        const guestContents = webContents.fromId(id)
        return {
          main: mainContents?.getOSProcessId() ?? null,
          guest: guestContents?.getOSProcessId() ?? null,
          guestUrl: guestContents?.getURL() ?? null
        }
      },
      { expectedUrl: appUrl, id: guestId }
    )
    expect(processes.main).toBeGreaterThan(0)
    expect(processes.guest).toBeGreaterThan(0)
    expect(processes.guest).not.toBe(processes.main)

    // Deferred so executeJavaScript resolves before the guest's main thread spins.
    await evalInGuest(guest, `setTimeout(() => document.getElementById('busy').click(), 0)`)

    await expect(
      orcaPage.getByText('This plugin panel stopped responding and was suspended.')
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      orcaPage.getByRole('button', { name: new RegExp(`${panel.title}.*Error`) })
    ).toBeVisible()
    expect(orcaPage.url()).toBe(appUrl)
    expect(server.requests).toEqual([])
  } finally {
    await testInfo.attach('hostile-panel-processes', {
      body: Buffer.from(JSON.stringify(processes, null, 2)),
      contentType: 'application/json'
    })
    await attachProbeRequests(testInfo, server.requests)
    await server.close()
    await rm(tempRoot, { recursive: true, force: true })
  }
})
