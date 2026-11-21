// After serve restart, retain browser URLs and closed state but start pages only on demand.
import type { RuntimeClient } from '../../../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../../../src/shared/remote-runtime/session-graph/runtime-session-contracts'
import { createServer, type Server } from 'node:http'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  addRepoWorktree,
  cliClient,
  pairedClient,
  startHeadlessOracleHost
} from '../../layout/workspace-oracle/headless-layout-oracle-hosts'

/** A page server that counts loads per path: a page that has not started has loaded nothing. */
async function startPage(): Promise<{ url: string; server: Server; loads: Map<string, number> }> {
  const loads = new Map<string, number>()
  const server = createServer((request, response) => {
    loads.set(request.url ?? '', (loads.get(request.url ?? '') ?? 0) + 1)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>${request.url === '/next' ? 'next' : 'first'}</title>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('page server has no port')
  }
  return { url: `http://127.0.0.1:${address.port}`, server, loads }
}

async function browserRows(client: RuntimeClient, worktree: string) {
  const { result } = await client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree
  })
  return result.tabs.flatMap((tab) =>
    tab.type === 'browser' ? [{ id: tab.id, url: tab.url, title: tab.title }] : []
  )
}

async function listedTabs(client: RuntimeClient, worktree: string) {
  const listed = await client.call<{ tabs: { browserPageId: string; url: string }[] }>(
    'browser.tabList',
    { worktree }
  )
  return listed.result.tabs
}

test('restored serve browser tabs start only when a client opens them', async () => {
  // Two serve restarts and lazy Chromium startup run in this lifecycle.
  test.setTimeout(300_000)
  const page = await startPage()
  const host = await startHeadlessOracleHost('electron')
  try {
    const cli = cliClient(host)
    const phone = pairedClient(host, 'phone')
    const worktree = `id:${await addRepoWorktree(host, cli)}`
    const created = await phone.call<{ browserPageId: string }>('browser.tabCreate', {
      worktree,
      url: `${page.url}/first`
    })
    const pageId = created.result.browserPageId
    await phone.call('browser.goto', { worktree, page: pageId, url: `${page.url}/next` })
    await expect
      .poll(async () => (await browserRows(phone, worktree)).find((row) => row.id === pageId)?.url)
      .toBe(`${page.url}/next`)

    const activationUrl = `${page.url}/activate`
    const activatedId = (
      await phone.call<{ browserPageId: string }>('browser.tabCreate', {
        worktree,
        url: activationUrl
      })
    ).result.browserPageId
    await expect.poll(() => page.loads.get('/activate')).toBe(1)

    const loadsBeforeOpen = page.loads.get('/next') ?? 0
    await host.restart()

    // Both tabs are listed at their last addresses without loading them.
    await expect
      .poll(async () => browserRows(phone, worktree), { timeout: 30_000 })
      .toEqual(
        expect.arrayContaining([
          { id: pageId, url: `${page.url}/next`, title: 'next' },
          { id: activatedId, url: activationUrl, title: 'first' }
        ])
      )
    expect(page.loads.get('/next') ?? 0).toBe(loadsBeforeOpen)
    expect(page.loads.get('/activate')).toBe(1)

    // Driving it by page id, as an old client's stream does, starts it at that address.
    await phone.call('browser.snapshot', { worktree, page: pageId })
    await expect.poll(() => page.loads.get('/next')).toBe(loadsBeforeOpen + 1)
    await expect
      .poll(
        async () =>
          (await listedTabs(cli, worktree)).find((tab) => tab.browserPageId === pageId)?.url
      )
      .toBe(`${page.url}/next`)

    // An explicit activation is the current client's way to start a cold tab.
    await phone.call('session.tabs.activate', { worktree, tabId: activatedId })
    await expect.poll(() => page.loads.get('/activate')).toBe(2)

    await phone.call('session.tabs.close', { worktree, tabId: activatedId, reason: 'user' })
    await phone.call('session.tabs.close', { worktree, tabId: pageId, reason: 'user' })
    await expect.poll(async () => browserRows(phone, worktree)).toEqual([])
    await host.restart()
    await expect
      .poll(async () => (await browserRows(phone, worktree)).length, { timeout: 15_000 })
      .toBe(0)
  } finally {
    await host.dispose()
    await new Promise((resolve) => page.server.close(resolve))
  }
})
