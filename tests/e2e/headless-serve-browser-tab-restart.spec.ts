/**
 * A browser tab on `orca serve` survives a serve restart, as a desktop's browser tabs survive a
 * relaunch: the restarted server lists it with its last address, and starts its page only when a
 * client opens or drives it. A closed tab stays closed.
 */
import type { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'
import { createServer, type Server } from 'node:http'
import { expect, test } from './helpers/orca-app'
import {
  addRepoWorktree,
  cliClient,
  pairedClient,
  startHeadlessOracleHost
} from './helpers/headless-layout-oracle-hosts'

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

test('a serve browser tab survives a restart and starts when opened', async () => {
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

    await host.restart()
    const loadsBeforeOpen = page.loads.get('/next')

    // Listed at its last address before anything opens it, with no page running yet.
    await expect
      .poll(async () => browserRows(phone, worktree), { timeout: 30_000 })
      .toEqual([{ id: pageId, url: `${page.url}/next`, title: 'next' }])
    expect(page.loads.get('/next')).toBe(loadsBeforeOpen)

    // Driving it by page id, as an old client's stream does, starts it at that address.
    await phone.call('browser.snapshot', { worktree, page: pageId })
    await expect.poll(() => page.loads.get('/next')).toBe((loadsBeforeOpen ?? 0) + 1)
    await expect
      .poll(
        async () =>
          (await listedTabs(cli, worktree)).find((tab) => tab.browserPageId === pageId)?.url
      )
      .toBe(`${page.url}/next`)

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

test('tapping a restored serve browser tab starts its page', async () => {
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
    await expect.poll(() => page.loads.get('/first')).toBe(1)
    await host.restart()
    await expect.poll(async () => (await browserRows(phone, worktree)).length).toBe(1)
    expect(page.loads.get('/first')).toBe(1)

    await phone.call('session.tabs.activate', { worktree, tabId: pageId })

    await expect.poll(() => page.loads.get('/first')).toBe(2)
  } finally {
    await host.dispose()
    await new Promise((resolve) => page.server.close(resolve))
  }
})
