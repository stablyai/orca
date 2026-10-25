// Prove active-view.json → ui.get → startup hydration across real restarts, with a workspace so terminal hydration cannot mask view restore.

import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { TEST_REPO_PATH_FILE } from './global-setup'

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

test('restores the active top-level view (Tasks) after an app restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const first = await session.launch()
    firstApp = first.app
    await waitForSessionReady(first.page)
    // Attach a workspace or Landing bypasses the view switch; settle worktree activation before navigating.
    await attachRepoAndOpenTerminal(first.page, repoPath)

    expect(await getStoreState<string>(first.page, 'activeView')).toBe('terminal')

    await first.page.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().openTaskPage()
    })
    await expect
      .poll(async () => getStoreState<string>(first.page, 'activeView'), { timeout: 10_000 })
      .toBe('tasks')
    // Use locale-independent Tasks chrome; the Close tasks label is translated.
    await expect(
      first.page.locator('[data-contextual-tour-target="tasks-source-filters"]')
    ).toBeVisible({ timeout: 10_000 })
    await expect(first.page.locator('.xterm')).not.toBeVisible({ timeout: 10_000 })

    // Exercise the synchronous quit checkpoint before an asynchronous preference write can finish.
    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)

    await expect
      .poll(async () => getStoreState<string>(second.page, 'activeView'), { timeout: 10_000 })
      .toBe('tasks')
    await expect(
      second.page.locator('[data-contextual-tour-target="tasks-source-filters"]')
    ).toBeVisible({ timeout: 10_000 })
    await expect(second.page.locator('.xterm')).not.toBeVisible({ timeout: 10_000 })
  } finally {
    // Guard each step so a failing close still runs the remaining cleanup.
    for (const app of [secondApp, firstApp]) {
      if (!app) {
        continue
      }
      try {
        await session.close(app)
      } catch {}
    }
    await session.dispose()
  }
})
