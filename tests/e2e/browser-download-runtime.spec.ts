import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test, expect } from './helpers/orca-app'
import { sendRequest } from '../../src/cli/runtime/transport'
import { runProcess } from '../../src/shared/child-process/run-process'
import { readRuntimeMetadata } from '../../src/main/runtime/runtime-metadata'

test('native attachment capture, blank links, and inert download keep the runtime healthy', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  const bytes = Buffer.from('orca-visible-download-proof\n')
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '/')
    if (request.url?.startsWith('/proof')) {
      if (!request.headers.cookie?.includes('orca-download-proof=isolated')) {
        response.writeHead(403)
        response.end('Wrong profile')
        return
      }
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="orca-proof.txt"'
      })
      response.end(bytes)
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': 'orca-download-proof=isolated; SameSite=Lax; Path=/'
    })
    response.end(
      '<!doctype html><title>Download proof</title><a id="normal" href="/proof" download>Normal attachment</a><br><a id="blank" href="/proof?blank" target="_blank" rel="noopener noreferrer">Blank attachment</a><br><button id="inert">No download</button>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const data = await electronApp.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    pid: process.pid
  }))
  const downloads = join(data.userData, 'proof-downloads')
  mkdirSync(downloads)
  await electronApp.evaluate(({ app }, directory) => app.setPath('downloads', directory), downloads)
  const metadata = readRuntimeMetadata(data.userData)!
  expect(metadata).toBeTruthy()
  expect(metadata.pid).toBe(data.pid)
  const call = (method: string, params: unknown) =>
    sendRequest<Record<string, unknown>>(metadata, method, params, 30_000)
  try {
    const owner = await orcaPage.evaluate(async (url) => {
      const profile = await window.api.browser.sessionCreateProfile({
        scope: 'isolated',
        label: 'Download proof profile'
      })
      if (!profile) {
        throw new Error('Could not create the fixture profile.')
      }
      const store = window.__store!.getState()
      const worktreeId = store.activeWorktreeId!
      const tab = store.createBrowserTab(worktreeId, url, {
        activate: true,
        sessionProfileId: profile.id,
        sessionPartition: profile.partition
      })
      return {
        worktreeId,
        tabId: tab.id,
        pageId: tab.activePageId!,
        profileId: tab.sessionProfileId
      }
    }, origin)
    await expect
      .poll(async () => (await call('browser.get', { page: owner.pageId, what: 'title' })).ok)
      .toBe(true)
    const normalPath = join(downloads, 'requested.txt')
    const ordinary = await call('browser.download', {
      page: owner.pageId,
      selector: '#normal',
      path: normalPath
    })
    expect(ordinary.ok, JSON.stringify(ordinary)).toBe(true)
    expect(ordinary.ok && ordinary.result).toMatchObject({ path: normalPath, bytes: bytes.length })
    expect(readFileSync(normalPath)).toEqual(bytes)
    expect(existsSync(join(downloads, 'orca-proof.txt'))).toBe(false)

    const cliPath = join(downloads, 'cli-requested.txt')
    const cli = await runProcess({
      program: process.execPath,
      args: [
        join(process.cwd(), 'out', 'cli', 'index.js'),
        'download',
        '--page',
        owner.pageId,
        '--selector',
        '#normal',
        '--path',
        cliPath,
        '--json'
      ],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_USER_DATA_PATH: data.userData },
      timeoutMs: 90_000
    })
    expect(cli.code, cli.stderr + cli.stdout).toBe(0)
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, result: { path: cliPath } })
    expect(readFileSync(cliPath)).toEqual(bytes)

    const collision = await call('browser.download', {
      page: owner.pageId,
      selector: '#normal',
      path: normalPath
    })
    expect(collision.ok).toBe(false)
    expect(!collision.ok && collision.error.code).toBe('browser_download_destination_unavailable')
    expect(readFileSync(normalPath)).toEqual(bytes)

    const blankClick = await call('browser.click', { page: owner.pageId, element: '#blank' })
    expect(blankClick.ok, JSON.stringify(blankClick)).toBe(true)
    await expect.poll(() => existsSync(join(downloads, 'orca-proof.txt'))).toBe(true)
    expect(readFileSync(join(downloads, 'orca-proof.txt'))).toEqual(bytes)
    const child = await orcaPage.evaluate(({ worktreeId, tabId }) => {
      const store = window.__store!.getState()
      return (store.browserTabsByWorktree[worktreeId] ?? []).find(
        (tab) =>
          tab.id !== tabId &&
          (store.browserPagesByWorkspace[tab.id] ?? []).some((page) =>
            page.url.includes('/proof?blank')
          )
      )
    }, owner)
    expect(child?.sessionProfileId).toBe(owner.profileId)
    expect(child?.worktreeId).toBe(owner.worktreeId)
    await expect(orcaPage.locator(`[data-tab-id="${child!.id}"]`)).toBeVisible()

    const blankPath = join(downloads, 'requested-blank.txt')
    const blankCapture = await call('browser.download', {
      page: owner.pageId,
      selector: '#blank',
      path: blankPath
    })
    expect(blankCapture.ok, JSON.stringify(blankCapture)).toBe(true)
    expect(readFileSync(blankPath)).toEqual(bytes)

    const nativeClick = await call('browser.click', { page: owner.pageId, element: '#normal' })
    expect(nativeClick.ok).toBe(true)
    await expect.poll(() => existsSync(join(downloads, 'orca-proof (1).txt'))).toBe(true)
    expect(readFileSync(join(downloads, 'orca-proof (1).txt'))).toEqual(bytes)

    const started = Date.now()
    const inert = await call('browser.download', {
      page: owner.pageId,
      selector: '#inert',
      path: join(downloads, 'inert.txt')
    })
    const elapsedMs = Date.now() - started
    expect(inert.ok).toBe(false)
    expect(!inert.ok && inert.error.code).toBe('browser_download_timeout')
    expect(!inert.ok && inert.error.message).toContain('No download started')
    expect(elapsedMs).toBeGreaterThan(30_000)
    expect(existsSync(join(downloads, 'inert.txt'))).toBe(false)
    const healthy = await call('browser.get', { page: owner.pageId, what: 'title' })
    expect(healthy.ok, JSON.stringify(healthy)).toBe(true)
    const folderPath = join(data.userData, 'folder-workspace')
    mkdirSync(folderPath)
    const folderOwner = await orcaPage.evaluate(
      async ({ folderPath, origin }) => {
        const group = await window.api.projectGroups.create({
          name: 'Download folder proof',
          parentPath: folderPath
        })
        const folder = await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          name: 'Documents',
          folderPath
        })
        await window.__store!.getState().fetchProjectGroups()
        await window.__store!.getState().fetchFolderWorkspaces()
        await window.__store!.getState().setActiveFolderWorkspace(folder.id)
        const worktreeId = `folder:${folder.id}`
        const tab = window
          .__store!.getState()
          .createBrowserTab(worktreeId, origin, { activate: true })
        return { worktreeId, pageId: tab.activePageId! }
      },
      { folderPath, origin }
    )
    await expect
      .poll(async () => (await call('browser.get', { page: folderOwner.pageId, what: 'title' })).ok)
      .toBe(true)
    const folderDownloadPath = join(downloads, 'folder-attachment.txt')
    const folderDownload = await call('browser.download', {
      page: folderOwner.pageId,
      selector: '#blank',
      path: folderDownloadPath
    })
    expect(folderDownload.ok, JSON.stringify(folderDownload)).toBe(true)
    expect(readFileSync(folderDownloadPath)).toEqual(bytes)
    const windows = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused()
      }))
    )
    expect(windows.every((window) => !window.visible && !window.focused)).toBe(true)
    for (const name of readdirSync(downloads)) {
      writeFileSync(testInfo.outputPath(name), readFileSync(join(downloads, name)))
    }
    writeFileSync(
      testInfo.outputPath('download-receipt.json'),
      JSON.stringify(
        {
          pid: data.pid,
          userData: data.userData,
          runtimeId: metadata.runtimeId,
          owner,
          child,
          ordinary,
          cli,
          blankCapture,
          collision,
          inert,
          elapsedMs,
          healthy,
          folderOwner,
          folderDownload,
          windows,
          requests,
          files: readdirSync(downloads).map((name) => ({
            name,
            bytes: readFileSync(join(downloads, name)).length,
            sha256: createHash('sha256')
              .update(readFileSync(join(downloads, name)))
              .digest('hex')
          }))
        },
        null,
        2
      )
    )
    await orcaPage.evaluate(({ worktreeId, pageId }) => {
      window.__store!.getState().focusBrowserTabInWorktree(worktreeId, pageId)
    }, folderOwner)
    let guestId: number | null = null
    await expect
      .poll(async () => {
        guestId = await orcaPage.evaluate(async (browserPageId) => {
          for (const element of document.querySelectorAll('webview')) {
            const webview = element as Electron.WebviewTag
            const webContentsId = webview.getWebContentsId()
            if (await window.api.browser.isGuestRegistered({ browserPageId, webContentsId })) {
              return webContentsId
            }
          }
          return null
        }, folderOwner.pageId)
        return guestId
      })
      .not.toBeNull()
    const png = await electronApp.evaluate(async ({ webContents }, id) => {
      const guest = webContents.fromId(id!)!
      const ownedAttachment = !guest.debugger.isAttached()
      if (ownedAttachment) {
        guest.debugger.attach('1.3')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await guest.debugger.sendCommand('Page.enable')
        const screenshot = await Promise.race([
          guest.debugger.sendCommand('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: false
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Guest CDP screenshot timed out after 15 seconds.')),
              15_000
            )
          })
        ])
        return screenshot.data as string
      } finally {
        clearTimeout(timer)
        if (ownedAttachment && guest.debugger.isAttached()) {
          guest.debugger.detach()
        }
      }
    }, guestId)
    expect(Buffer.from(png, 'base64').length).toBeGreaterThan(1000)
    writeFileSync(testInfo.outputPath('download-renderer.png'), Buffer.from(png, 'base64'))
    const stillHidden = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
    expect(stillHidden).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
