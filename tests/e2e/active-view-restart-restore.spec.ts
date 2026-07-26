/**
 * The active top-level view survives a full app restart.
 *
 * Reproduces the reported bug (renderer reload / relaunch always snapped back
 * to the terminal, discarding whichever top-level view — Tasks, Automations,
 * etc. — the user had open) and asserts the fix: activeView now rides its
 * profile preference pipeline and is restored on the first startup hydration.
 *
 * Restart-persistence lives in E2E, not a store unit test: it needs the real
 * write -> active-view.json -> ui.get() -> hydratePersistedUI round-trip across
 * two Electron launches sharing one userDataDir, then the render layer proving
 * the page actually came back — with a real repo/worktree attached so the
 * relaunch also exercises the startup worktree hydration path (which must not
 * force the view back to the terminal).
 */

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
    // Attach a repo + open its terminal so there is an active worktree; without
    // one the app renders Landing instead of the view switch. This also settles
    // startup worktree activation before we navigate.
    await attachRepoAndOpenTerminal(first.page, repoPath)

    // Precondition: attaching lands on the terminal.
    expect(await getStoreState<string>(first.page, 'activeView')).toBe('terminal')

    // Navigate to a non-terminal top-level view (store drives setup; the DOM
    // proves the outcome, per tests/e2e/AGENTS.md).
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
    // Locale-independent render proof: the tasks source-filter chrome is on
    // screen (getByRole('Close tasks') is unusable — the label is localized).
    await expect(
      first.page.locator('[data-contextual-tour-target="tasks-source-filters"]')
    ).toBeVisible({ timeout: 10_000 })
    // And the terminal grid is not the active surface.
    await expect(first.page.locator('.xterm')).not.toBeVisible({ timeout: 10_000 })

    // Closing also exercises the synchronous checkpoint that covers the race
    // where exit starts before the tiny asynchronous preference write finishes.
    await session.close(firstApp)
    firstApp = null

    // Relaunch against the same userDataDir — the real reload/restore path.
    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)

    // Fix: the restored launch reopens Tasks instead of resetting to terminal,
    // and neither the cross-window sync re-hydration nor startup worktree
    // hydration clobbers the restored view.
    await expect
      .poll(async () => getStoreState<string>(second.page, 'activeView'), { timeout: 10_000 })
      .toBe('tasks')
    // Render-layer proof: the Tasks page chrome is on screen and the terminal
    // is not — i.e. the relaunch did not snap back to the terminal.
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
      } catch {
        // best-effort cleanup
      }
    }
    await session.dispose()
  }
})
