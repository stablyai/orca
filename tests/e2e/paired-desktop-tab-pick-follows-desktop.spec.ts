import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'

/** The tab the server remembers for this device, as its per-device projection reports it. */
function serverPickedTab(page: Page, environmentId: string, worktreeId: string) {
  return page.evaluate(
    async ({ environmentId, worktreeId }) => {
      const response: unknown = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'session.tabs.list',
        params: { worktree: `id:${worktreeId}` }
      })
      if (
        typeof response !== 'object' ||
        response === null ||
        !('result' in response) ||
        typeof response.result !== 'object' ||
        response.result === null ||
        !('tabGroups' in response.result) ||
        !Array.isArray(response.result.tabGroups)
      ) {
        return null
      }
      const first: unknown = response.result.tabGroups[0]
      return typeof first === 'object' &&
        first !== null &&
        'activeTabId' in first &&
        typeof first.activeTabId === 'string'
        ? first.activeTabId
        : null
    },
    { environmentId, worktreeId }
  )
}

function desktopActiveTab(page: Page, worktreeId: string) {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    return (
      (state.groupsByWorktree[id] ?? []).find(
        (group) => group.id === state.activeGroupIdByWorktree[id]
      )?.activeTabId ?? null
    )
  }, worktreeId)
}

// A server workspace opened without the desktop's own tab groups (first open, or a saved session
// that lost them) lands on the tab the server remembers for this device, so that must be the one
// the desktop last showed.
test('a desktop restart brings a stale server pick back to the tab the desktop shows', async ({
  testRepoPath
}, testInfo) => {
  // Two desktop launches against a paired host, with a restart between them.
  test.setTimeout(300_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const first = await host.client.call<{ terminal: { worktreeId: string } }>('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'one'
    })
    await host.client.call('terminal.create', { worktree: `path:${testRepoPath}`, title: 'two' })
    const worktreeId = first.result.terminal.worktreeId
    client = await launchPairedElectronClient(host.offer, testInfo, 'tab-pick')
    const { page, environmentId } = client
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((w) => w.id === id) ?? false,
            worktreeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    await page.evaluate((id) => {
      const state = window.__store!.getState()
      state.setActiveView('terminal')
      state.setActiveWorktree(id)
    }, worktreeId)
    await expect(page.locator('[data-tab-id]')).toHaveCount(2, { timeout: 60_000 })
    const order = await page.evaluate(
      (id) => (window.__store!.getState().groupsByWorktree[id] ?? [])[0]?.tabOrder ?? [],
      worktreeId
    )
    await page.locator(`[data-tab-id="${order[1]}"]`).first().click()
    await page.locator(`[data-tab-id="${order[0]}"]`).first().click()
    await expect.poll(() => desktopActiveTab(page, worktreeId)).toBe(order[0])
    const hostTabId = (localTabId: string): string => localTabId.replace(/^web-terminal-/, '')
    await expect
      .poll(() => serverPickedTab(page, environmentId, worktreeId), { timeout: 30_000 })
      .toBe(hostTabId(order[0]))

    // Leave a stale pick for this device, as an older client or a background path could.
    await page.evaluate(
      async ({ environmentId, worktreeId, tabId }) =>
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'session.tabs.activate',
          params: {
            worktree: `id:${worktreeId}`,
            tabId,
            notifyClients: false,
            navigation: 'caller'
          }
        }),
      { environmentId, worktreeId, tabId: hostTabId(order[1]) }
    )

    // Restart the desktop: it reopens on its own saved tab and brings the server's pick back to it.
    const userDataDir = client.userDataDir
    await client.quitPreservingProfile()
    client = await launchPairedElectronClient(host.offer, testInfo, 'tab-pick', {
      reuseUserDataDir: userDataDir
    })
    const relaunched = client.page
    await expect
      .poll(
        () =>
          relaunched.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((w) => w.id === id) ?? false,
            worktreeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    await relaunched.evaluate((id) => {
      const state = window.__store!.getState()
      state.setActiveView('terminal')
      state.setActiveWorktree(id)
    }, worktreeId)
    await expect.poll(() => desktopActiveTab(relaunched, worktreeId)).toBe(order[0])
    await expect
      .poll(() => serverPickedTab(relaunched, client!.environmentId, worktreeId), {
        timeout: 30_000
      })
      .toBe(hostTabId(order[0]))
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
