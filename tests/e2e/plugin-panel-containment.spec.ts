/**
 * Invariant: a plugin panel cannot exfiltrate, navigate, or bypass bridge budgets.
 * Oracle: a permissive loopback server receives zero requests while the real
 * sandboxed iframe reports CSP/navigation containment and actual budget refusals.
 * Chromium is required because Vitest cannot exercise CSP or iframe sandboxing.
 * Maturity: experimental until this has CI soak history on all desktop platforms.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, FrameLocator, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

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

type PanelDocumentSnapshot = {
  url: string
  title: string
  html: string
}

type ElectronFrameProcess = {
  frameTreeNodeId: number
  parentFrameTreeNodeId: number | null
  processId: number
  osProcessId: number
  url: string
  origin: string
  marker: string | null
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
  await cp(join(process.cwd(), 'examples', 'plugins', 'hostile-panel'), pluginRoot, {
    recursive: true
  })
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

async function openPanel(page: Page, panel: InstalledPanel): Promise<void> {
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
  await expect(page.locator(`iframe[title="${panel.title}"]`)).toBeVisible({ timeout: 15_000 })
}

async function attachProbeRequests(testInfo: TestInfo, requests: readonly string[]): Promise<void> {
  await testInfo.attach('hostile-panel-loopback-requests', {
    body: Buffer.from(JSON.stringify(requests, null, 2)),
    contentType: 'application/json'
  })
}

async function readPanelDocument(frame: FrameLocator): Promise<PanelDocumentSnapshot> {
  return frame.locator('html').evaluate((element) => ({
    url: element.ownerDocument.location.href,
    title: element.ownerDocument.title,
    html: element.outerHTML
  }))
}

async function inspectElectronFrameProcesses(
  electronApp: ElectronApplication,
  pageUrl: string
): Promise<ElectronFrameProcess[]> {
  return electronApp.evaluate(async ({ BrowserWindow }, expectedUrl) => {
    const browserWindow =
      BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === expectedUrl
      ) ?? BrowserWindow.getAllWindows()[0]
    if (!browserWindow) {
      return []
    }
    return Promise.all(
      browserWindow.webContents.mainFrame.framesInSubtree.map(async (frame) => {
        let marker: string | null = null
        try {
          const value = await frame.executeJavaScript(
            "document.querySelector('h1')?.textContent ?? null"
          )
          marker = typeof value === 'string' ? value : null
        } catch {
          // A frame can detach while Chromium reports the live frame tree.
        }
        return {
          frameTreeNodeId: frame.frameTreeNodeId,
          parentFrameTreeNodeId: frame.parent?.frameTreeNodeId ?? null,
          processId: frame.processId,
          osProcessId: frame.osProcessId,
          url: frame.url,
          origin: frame.origin,
          marker
        }
      })
    )
  }, pageUrl)
}

test('contains hostile panel network, navigation, and bridge-flood probes', async ({
  orcaPage
}, testInfo) => {
  testInfo.annotations.push({ type: 'maturity', description: 'experimental' })
  const server = await startPermissiveProbeServer()
  const pluginRoot = await materializeHostilePlugin(server.origin)
  const tempRoot = join(pluginRoot, '..')
  const appUrl = orcaPage.url()
  const browserEvents: string[] = []
  const panelDocuments: PanelDocumentSnapshot[] = []
  orcaPage.on('console', (message) => {
    browserEvents.push(`console:${message.type()}:${message.text()}`)
  })
  orcaPage.on('pageerror', (error) => {
    browserEvents.push(`pageerror:${error.message}`)
  })
  orcaPage.on('framenavigated', (frame) => {
    browserEvents.push(`framenavigated:${frame.url()}`)
  })
  try {
    const panel = await installApprovedPanel(orcaPage, pluginRoot)
    await openPanel(orcaPage, panel)

    const iframe = orcaPage.locator(`iframe[title="${panel.title}"]`)
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
    const frame = orcaPage.frameLocator(`iframe[title="${panel.title}"]`)
    await expect(frame.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      'content',
      /connect-src 'none'.*img-src data:/
    )
    const initialPanelDebug = await frame.locator('html').evaluate((element) => ({
      readyState: element.ownerDocument.readyState,
      scriptCount: element.ownerDocument.scripts.length,
      resultCount: element.querySelectorAll('[data-probe]').length,
      bodyText: element.ownerDocument.body?.textContent ?? '',
      scriptText: Array.from(element.ownerDocument.scripts, (script) => script.textContent ?? '')
    }))
    await testInfo.attach('hostile-panel-initial-debug', {
      body: Buffer.from(JSON.stringify(initialPanelDebug, null, 2)),
      contentType: 'application/json'
    })

    for (const probe of ['fetch-exfil', 'img-beacon']) {
      await expect(frame.locator(`[data-probe="${probe}"]`)).toHaveAttribute(
        'data-contained',
        'true',
        { timeout: 5_000 }
      )
    }

    await frame.getByRole('button', { name: 'Run bridge budget probes' }).click()
    for (const probe of ['oversized-message', 'message-flood']) {
      await expect(frame.locator(`[data-probe="${probe}"]`)).toHaveAttribute(
        'data-contained',
        'true',
        { timeout: 5_000 }
      )
    }

    expect(server.requests).toEqual([])
    expect(orcaPage.url()).toBe(appUrl)
    await expect(iframe).toBeVisible()

    const initialDocument = await readPanelDocument(frame)
    panelDocuments.push(initialDocument)
    for (const navigation of [
      { button: 'Try top navigation', probe: 'top-navigation' },
      { button: 'Try self navigation', probe: 'self-navigation' },
      { button: 'Try anchor and form navigation', probe: 'anchor-form-navigation' },
      { button: 'Try meta refresh navigation', probe: 'meta-refresh-navigation' }
    ]) {
      await frame.getByRole('button', { name: navigation.button }).click()
      await expect(frame.locator(`[data-probe="${navigation.probe}"]`)).toHaveAttribute(
        'data-contained',
        'true',
        { timeout: 5_000 }
      )
      const currentDocument = await readPanelDocument(frame)
      panelDocuments.push(currentDocument)
      expect(currentDocument.url).toBe(initialDocument.url)
      expect(currentDocument.html).toContain('Hostile panel fixture')
      expect(server.requests).toEqual([])
      expect(orcaPage.url()).toBe(appUrl)
    }
  } finally {
    await attachProbeRequests(testInfo, server.requests)
    await testInfo.attach('hostile-panel-browser-events', {
      body: Buffer.from(browserEvents.join('\n')),
      contentType: 'text/plain'
    })
    await testInfo.attach('hostile-panel-documents', {
      body: Buffer.from(JSON.stringify(panelDocuments, null, 2)),
      contentType: 'application/json'
    })
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
  let frameProcesses: ElectronFrameProcess[] = []
  try {
    const panel = await installApprovedPanel(orcaPage, pluginRoot)
    await openPanel(orcaPage, panel)

    await expect
      .poll(
        async () => {
          frameProcesses = await inspectElectronFrameProcesses(electronApp, appUrl)
          return frameProcesses.some((frame) => frame.marker === 'Hostile panel fixture')
        },
        { timeout: 5_000, message: 'hostile panel should appear in Electron frame tree' }
      )
      .toBe(true)

    const mainFrame = frameProcesses.find((frame) => frame.parentFrameTreeNodeId === null)
    const panelFrame = frameProcesses.find((frame) => frame.marker === 'Hostile panel fixture')
    expect(mainFrame).toBeTruthy()
    expect(panelFrame).toBeTruthy()
    expect(panelFrame?.processId).not.toBe(mainFrame?.processId)
    expect(panelFrame?.osProcessId).not.toBe(mainFrame?.osProcessId)

    const iframe = orcaPage.locator(`iframe[title="${panel.title}"]`)
    await iframe.evaluate((element) => {
      const panelWindow = (element as HTMLIFrameElement).contentWindow
      panelWindow?.postMessage({ type: 'orca-hostile-busy-probe' }, '*')
    })

    await expect(
      orcaPage.getByText('This plugin panel stopped responding and was suspended.')
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      orcaPage.getByRole('button', { name: new RegExp(`${panel.title}.*Error`) })
    ).toBeVisible()
    expect(orcaPage.url()).toBe(appUrl)
    expect(server.requests).toEqual([])
  } finally {
    await testInfo.attach('hostile-panel-frame-processes', {
      body: Buffer.from(JSON.stringify(frameProcesses, null, 2)),
      contentType: 'application/json'
    })
    await attachProbeRequests(testInfo, server.requests)
    await server.close()
    await rm(tempRoot, { recursive: true, force: true })
  }
})
