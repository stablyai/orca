import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'
import { TEST_REPO_PATH_FILE } from './global-setup'

function seededRepoPath(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  if (!repoPath || !existsSync(repoPath)) {
    throw new Error('Detached-window restart E2E requires the seeded test repo from global setup')
  }
  return repoPath
}

test('reopens a detached tab group window after quit and relaunch', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = seededRepoPath()
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    await waitForSessionReady(first.page)
    await attachRepoAndOpenTerminal(first.page, repoPath)
    await ensureTerminalVisible(first.page)
    await waitForActiveTerminalManager(first.page, 30_000)

    const groupId = await first.page.evaluate(() => {
      const state = window.__store.getState()
      const worktreeId = state.activeWorktreeId
      return worktreeId ? (state.groupsByWorktree[worktreeId]?.[0]?.id ?? null) : null
    })
    expect(groupId).not.toBeNull()

    const firstAuxPromise = firstApp.waitForEvent('window', { timeout: 30_000 })
    await first.page.evaluate((id) => {
      window.__store.getState().detachTabGroup(id)
    }, groupId)
    const firstAux = await firstAuxPromise
    await expect(firstAux.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 })

    // Why: the session writer is debounced — quitting too early persists nothing.
    await first.page.waitForTimeout(3_000)
    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app

    // Why: two windows now exist at startup, and the harness hands back
    // whichever appeared first — identify them by URL instead of assuming.
    const isAux = (page: { url: () => string }): boolean => page.url() === 'about:blank'
    const deadline = Date.now() + 60_000
    let restoredAux: (typeof second)['page'] | undefined
    let mainPage: (typeof second)['page'] | undefined
    while (Date.now() < deadline && (!restoredAux || !mainPage)) {
      const windows = secondApp.windows()
      restoredAux = windows.find(isAux)
      mainPage = windows.find((page) => !isAux(page))
      if (!restoredAux || !mainPage) {
        await second.page.waitForTimeout(500).catch(() => undefined)
      }
    }
    expect(restoredAux, 'detached window should reopen on restart').toBeDefined()
    expect(mainPage).toBeDefined()

    await expect(restoredAux!.locator('.xterm-screen')).toBeVisible({ timeout: 60_000 })
    await expect(mainPage!.locator('.xterm-screen')).toHaveCount(0, { timeout: 15_000 })
  } finally {
    for (const app of [secondApp, firstApp]) {
      if (app) {
        await session.close(app).catch(() => undefined)
      }
    }
    await session.dispose()
  }
})
