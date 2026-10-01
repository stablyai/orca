import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './store'

/** Writes an unpacked extension: manifest.json plus the named files. */
export function writeTestExtension(manifest: object, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-extension-'))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, version: '1.0', ...manifest })
  )
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

export async function startHtmlServer(
  render: (request: IncomingMessage, port: number) => string
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(render(request, port))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test server has no port')
  }
  const { port } = address
  return { server, port, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

export async function evalInPage(page: Page, pageId: string, expression: string): Promise<unknown> {
  const response = await page.evaluate(
    ({ targetPage, targetExpression }) =>
      window.api.runtime.call({
        method: 'browser.eval',
        params: { page: targetPage, expression: targetExpression }
      }),
    { targetPage: pageId, targetExpression: expression }
  )
  const result = Reflect.get(Object(response), 'result')
  return Reflect.get(Object(result), 'result')
}

/**
 * Opens `url` in an Orca browser tab, loads the extension into that tab's session, and reloads
 * so content scripts inject. Resolves the page id and the guest WebContents id.
 */
export async function openPageWithExtension(
  orcaPage: Page,
  electronApp: ElectronApplication,
  url: string,
  title: string,
  extensionDir: string
): Promise<{ pageId: string; guestId: number }> {
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const worktreeId = await getActiveWorktreeId(orcaPage)
  const pageId = await orcaPage.evaluate(
    ({ targetWorktreeId, targetUrl, targetTitle }) =>
      window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
        title: targetTitle,
        activate: true
      })?.activePageId ?? null,
    { targetWorktreeId: worktreeId!, targetUrl: url, targetTitle: title }
  )
  expect(pageId).toBeTruthy()
  await expect.poll(() => evalInPage(orcaPage, pageId!, 'document.title')).toBe(title)
  const guestId = await electronApp.evaluate(
    async ({ webContents }, { pageUrl, dir }) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getURL() === pageUrl)
      if (!guest) {
        throw new Error('page not found')
      }
      await guest.session.extensions.loadExtension(dir)
      return guest.id
    },
    { pageUrl: url, dir: extensionDir }
  )
  await evalInPage(orcaPage, pageId!, 'location.reload()')
  await expect.poll(() => evalInPage(orcaPage, pageId!, 'document.readyState')).toBe('complete')
  return { pageId: pageId!, guestId }
}

/** Real input through the guest's DevTools session, which Orca keeps attached. */
export async function dispatchGuestInput(
  electronApp: ElectronApplication,
  guestId: number,
  events: { method: string; params: object }[]
): Promise<void> {
  await electronApp.evaluate(
    async ({ webContents }, { id, commands }) => {
      const guest = webContents.fromId(id)
      if (!guest) {
        throw new Error('guest not found')
      }
      if (!guest.debugger.isAttached()) {
        guest.debugger.attach('1.3')
      }
      for (const command of commands) {
        await guest.debugger.sendCommand(command.method, command.params)
      }
    },
    { id: guestId, commands: events }
  )
}
