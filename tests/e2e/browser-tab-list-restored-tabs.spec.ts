/**
 * After a restart Orca restores browser tabs lazily: only a tab the user opens gets a page.
 * Agents still need every tab in the tab bar, so `tab list` reports the restored ones too, and a
 * command aimed at one loads it in the background without changing the tab the user sees.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { startBrowserSplitPageServer } from './helpers/browser-split-page-server'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { readProperty, rpc } from './helpers/browser-agent-focus-scenarios'

type ListedTab = { browserPageId: string; title: string; active: boolean; loaded: unknown }

async function listTabs(page: Page, worktree: string): Promise<ListedTab[]> {
  const tabs = readProperty(await rpc(page, 'browser.tabList', { worktree }), 'tabs')
  return Array.isArray(tabs)
    ? tabs.map((tab: unknown) => ({
        browserPageId: String(readProperty(tab, 'browserPageId')),
        title: String(readProperty(tab, 'title')),
        active: readProperty(tab, 'active') === true,
        loaded: readProperty(tab, 'loaded')
      }))
    : []
}

function activeBrowserTabId(page: Page, worktreeId: string): Promise<string | null> {
  return page.evaluate(
    (id) => window.__store?.getState().activeBrowserTabIdByWorktree[id] ?? null,
    worktreeId
  )
}

test('tab list reports restored tabs, and commands load them in the background', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  // Launches Orca twice and waits out a 10 s visibility lease.
  test.setTimeout(300_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  const server = await startBrowserSplitPageServer()
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    const worktree = `id:${worktreeId}`
    for (const pane of ['alpha', 'beta', 'gamma']) {
      await first.page.evaluate(
        ({ id, url, title }) =>
          window.__store?.getState().createBrowserTab(id, url, { title, activate: true }),
        { id: worktreeId, url: server.pageUrl(pane, 1), title: `${pane} 1` }
      )
    }
    await expect
      .poll(async () => (await listTabs(first.page, worktree)).map((tab) => tab.title))
      .toEqual(['alpha 1', 'beta 1', 'gamma 1'])
    await session.close(app)
    app = null

    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    await expect
      .poll(() => activeBrowserTabId(second.page, worktreeId), { timeout: 30_000 })
      .not.toBeNull()
    const visibleTabId = await activeBrowserTabId(second.page, worktreeId)

    // Only gamma, the tab on screen, has a page; alpha and beta are listed from the tab bar.
    await expect
      .poll(async () =>
        (await listTabs(second.page, worktree)).map((tab) => [tab.title, tab.loaded])
      )
      .toEqual([
        ['alpha 1', false],
        ['beta 1', false],
        ['gamma 1', true]
      ])

    const switched = await rpc(second.page, 'browser.tabSwitch', { worktree, index: 0 })
    const alphaPageId = String(readProperty(switched, 'browserPageId'))
    const title = await rpc(second.page, 'browser.eval', {
      worktree,
      page: alphaPageId,
      expression: 'document.title'
    })
    expect(readProperty(title, 'result')).toBe('alpha 1')
    expect(await activeBrowserTabId(second.page, worktreeId)).toBe(visibleTabId)

    // The wake's 10 s visibility lease lapsing must not unload the page again.
    // ast-grep-ignore: test-no-real-time-wait -- the lease is real time in the app and exposes no expiry signal
    await second.page.waitForTimeout(12_000)
    const later = await rpc(second.page, 'browser.eval', {
      worktree,
      page: alphaPageId,
      expression: 'document.title'
    })
    expect(readProperty(later, 'result')).toBe('alpha 1')

    await rpc(second.page, 'browser.tabClose', { worktree, index: 1 })
    await expect
      .poll(async () => (await listTabs(second.page, worktree)).map((tab) => tab.title))
      .toEqual(['alpha 1', 'gamma 1'])
  } finally {
    if (app) {
      await session.close(app)
    }
    await server.close()
  }
})
