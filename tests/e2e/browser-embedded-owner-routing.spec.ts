import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'

const execFileAsync = promisify(execFile)
// Why: Unix-domain helper sockets can exceed platform path limits under macOS's long temp root.
const shortTempRoot =
  process.platform === 'win32' ? os.tmpdir() : path.join(path.parse(os.tmpdir()).root, 'tmp')
const helperSocketDir = mkdtempSync(path.join(shortTempRoot, 'ob-'))
const blockedBrowserPath = path.join(
  helperSocketDir,
  process.platform === 'win32' ? 'blocked-browser.cmd' : 'blocked-browser'
)
const externalLaunchMarker = `${blockedBrowserPath}.attempted`

writeFileSync(
  blockedBrowserPath,
  process.platform === 'win32'
    ? '@echo off\r\ntype nul > "%~f0.attempted"\r\nexit /b 97\r\n'
    : '#!/bin/sh\n: > "$0.attempted"\nexit 97\n'
)
if (process.platform !== 'win32') {
  chmodSync(blockedBrowserPath, 0o755)
}

test.use({
  orcaAppExtraEnv: {
    AGENT_BROWSER_SOCKET_DIR: helperSocketDir,
    PATH: `${path.join(process.cwd(), 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`
  }
})

type CreatedBrowserTab = {
  id: string
  pageId: string
}

type RuntimeResponse = {
  ok: boolean
  result?: unknown
  error?: { code?: string; message?: string }
}

async function startOwnershipServer(): Promise<{
  sourceUrl: string
  destinationUrl: string
  close: () => Promise<void>
}> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const destination = pathname === '/destination'
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <html>
        <head><title>${destination ? 'Owned destination' : 'Owned source'}</title></head>
        <body><h1 id="marker">${destination ? 'destination-webview' : 'source-webview'}</h1></body>
      </html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    sourceUrl: `${origin}/source`,
    destinationUrl: `${origin}/destination`,
    close: () => closeServer(server)
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  )
}

async function createBrowserTab(
  page: Page,
  worktreeId: string,
  url: string
): Promise<CreatedBrowserTab> {
  const browserTab = await page.evaluate(
    ({ targetWorktreeId, targetUrl }) => {
      const created = window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
        title: 'Embedded owner smoke',
        activate: true
      })
      return created?.activePageId ? { id: created.id, pageId: created.activePageId } : null
    },
    { targetWorktreeId: worktreeId, targetUrl: url }
  )
  if (!browserTab) {
    throw new Error('Failed to create the embedded browser page')
  }
  return browserTab
}

async function callBrowserRuntime(
  page: Page,
  method: string,
  params: Record<string, unknown>
): Promise<RuntimeResponse> {
  return (await page.evaluate(
    ({ targetMethod, targetParams }) =>
      window.api.runtime.call({ method: targetMethod, params: targetParams }),
    { targetMethod: method, targetParams: params }
  )) as RuntimeResponse
}

async function readEmbeddedPage(
  page: Page,
  browserTabId: string
): Promise<{ marker: string | null; title: string; url: string } | null> {
  return page.evaluate(async (targetBrowserTabId) => {
    const overlay = document.querySelector(`[data-browser-overlay-tab-id="${targetBrowserTabId}"]`)
    const webview = overlay?.querySelector('webview') as Electron.WebviewTag | null
    if (!webview) {
      return null
    }
    try {
      return (await webview.executeJavaScript(`({
        marker: document.querySelector('#marker')?.textContent ?? null,
        title: document.title,
        url: location.href
      })`)) as { marker: string | null; title: string; url: string }
    } catch {
      return null
    }
  }, browserTabId)
}

function agentBrowserBinary(): string {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  return path.join(
    process.cwd(),
    'node_modules',
    'agent-browser',
    'bin',
    `agent-browser-${process.platform}-${process.arch}${suffix}`
  )
}

async function stopHelperDaemon(sessionName: string): Promise<void> {
  await execFileAsync(agentBrowserBinary(), ['--session', sessionName, 'close', '--json'], {
    env: { ...process.env, AGENT_BROWSER_SOCKET_DIR: helperSocketDir },
    timeout: 10_000
  })
  await expect
    .poll(() => existsSync(path.join(helperSocketDir, `${sessionName}.pid`)), { timeout: 5_000 })
    .toBe(false)
}

test('stale helper cannot take goto or eval away from the real embedded webview', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  registerPostElectronShutdownCleanup(async () => {
    rmSync(helperSocketDir, { recursive: true, force: true })
  })
  const server = await startOwnershipServer()
  try {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    if (!worktreeId) {
      throw new Error('Expected an active worktree for the embedded browser smoke test')
    }
    const browserTab = await createBrowserTab(orcaPage, worktreeId, server.sourceUrl)

    await expect
      .poll(() => readEmbeddedPage(orcaPage, browserTab.id), { timeout: 10_000 })
      .toMatchObject({ marker: 'source-webview', title: 'Owned source', url: server.sourceUrl })

    const snapshot = await callBrowserRuntime(orcaPage, 'browser.snapshot', {
      page: browserTab.pageId
    })
    expect(snapshot, JSON.stringify(snapshot)).toMatchObject({ ok: true })

    const sessionName = `orca-tab-${browserTab.pageId}`
    await expect
      .poll(() => existsSync(path.join(helperSocketDir, `${sessionName}.pid`)), {
        timeout: 5_000
      })
      .toBe(true)

    // Why: if routing escapes the registered webview, this executable records the attempt without launching Chrome.
    await electronApp.evaluate((_electron, executablePath) => {
      process.env.AGENT_BROWSER_EXECUTABLE_PATH = executablePath
    }, blockedBrowserPath)
    await stopHelperDaemon(sessionName)

    const navigation = await callBrowserRuntime(orcaPage, 'browser.goto', {
      page: browserTab.pageId,
      url: server.destinationUrl
    })
    expect(existsSync(externalLaunchMarker)).toBe(false)
    expect(navigation).toMatchObject({
      ok: true,
      result: { url: server.destinationUrl, title: 'Owned destination' }
    })
    await expect
      .poll(() => readEmbeddedPage(orcaPage, browserTab.id), { timeout: 10_000 })
      .toMatchObject({
        marker: 'destination-webview',
        title: 'Owned destination',
        url: server.destinationUrl
      })
    await expect(orcaPage.locator(`[data-tab-id="${browserTab.id}"]`)).toContainText(
      'Owned destination'
    )

    const evaluation = await callBrowserRuntime(orcaPage, 'browser.eval', {
      page: browserTab.pageId,
      expression: 'document.querySelector("#marker")?.textContent'
    })
    expect(existsSync(externalLaunchMarker)).toBe(false)
    expect(evaluation).toMatchObject({
      ok: true,
      result: { result: 'destination-webview', origin: server.destinationUrl }
    })
    // Why: the stopped helper has no cleanup left; a PID after eval means a forbidden relaunch.
    expect(existsSync(path.join(helperSocketDir, `${sessionName}.pid`))).toBe(false)
  } finally {
    await electronApp.evaluate(() => {
      delete process.env.AGENT_BROWSER_EXECUTABLE_PATH
    })
    await server.close()
  }
})
