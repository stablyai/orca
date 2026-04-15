/**
 * Shared Electron fixture for Orca E2E tests.
 *
 * Why: Playwright's native _electron.launch() is used instead of CDP.
 * It launches the Electron app directly from the built output, gives
 * full access to the BrowserWindow, and handles lifecycle automatically.
 * No need to manually start the app or pass --remote-debugging-port.
 *
 * Why: the fixture adds a dedicated test repo to the app so tests are
 * idempotent — they don't depend on whatever the user has open.
 *
 * Prerequisites:
 *   electron-vite build must have run first (globalSetup handles this).
 */

import { test as base, _electron as electron, type Page, type ElectronApplication } from '@stablyai/playwright-test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { TEST_REPO_PATH_FILE } from '../global-setup'

type OrcaTestFixtures = {
  electronApp: ElectronApplication
  sharedPage: Page
  orcaPage: Page
}

type OrcaWorkerFixtures = {
  /** Absolute path to the test git repo created by globalSetup. */
  testRepoPath: string
}

/**
 * Extended Playwright test with Orca-specific fixtures.
 *
 * `orcaPage` — the main Orca renderer window.
 *
 * Test-scoped: each test gets a fresh Electron instance and isolated
 * userData directory so state cannot leak across specs through persistence.
 */
export const test = base.extend<OrcaTestFixtures, OrcaWorkerFixtures>({
  // Worker-scoped: read the test repo path once
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  testRepoPath: [async ({}, provideFixture) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    await provideFixture(repoPath)
  }, { scope: 'worker' }],

  // Test-scoped: one Electron app per test
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  electronApp: async ({}, provideFixture) => {
    const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-userdata-'))
    const app = await electron.launch({
      args: [mainPath],
      // Why: keep NODE_ENV=development so window.__store is exposed and
      // dev-only helpers activate. ORCA_E2E_USER_DATA_DIR overrides the usual
      // shared dev profile so every spec gets a clean persistence root.
      // Why: ORCA_E2E_HEADLESS suppresses mainWindow.show() so the app
      // window stays hidden during test runs, avoiding focus stealing and
      // screen clutter. Playwright interacts via CDP regardless.
      // Why: ORCA_E2E_HEADLESS suppresses mainWindow.show() for CI/headless
      // runs. ORCA_E2E_HEADFUL overrides this for tests that need a visible
      // window (e.g. pointer-capture drag tests).
      env: {
        ...process.env,
        NODE_ENV: 'development',
        ORCA_E2E_USER_DATA_DIR: userDataDir,
        ...(process.env.ORCA_E2E_HEADFUL ? {} : { ORCA_E2E_HEADLESS: '1' }),
      },
    })
    await provideFixture(app)
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  },

  // Test-scoped: grab the first BrowserWindow, add the test repo, and wait
  // until the session is fully ready with a worktree active.
  sharedPage: async ({ electronApp, testRepoPath }, provideFixture) => {
    // Why: the Electron app may take a while to create the first window,
    // especially on cold start with no prior dev userData. Isolated per-test
    // profiles make late-suite launches slower, so use the full test budget.
    const page = await electronApp.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')

    // Wait for the store to be available
    await page.waitForFunction(
      () => Boolean(window.__store),
      null,
      { timeout: 30_000 }
    )

    // Add the test repo via the IPC bridge
    // Why: calling window.api.repos.add() goes through the same code path as
    // the "Add Repo" UI flow, ensuring worktrees are fetched and the session
    // initializes properly.
    await page.evaluate(async (repoPath) => {
      await window.api.repos.add({ path: repoPath })
    }, testRepoPath)

    // Fetch repos in the renderer store so it picks up the new repo
    await page.evaluate(async () => {
      const store = window.__store
      if (!store) {
        return
      }

      await store.getState().fetchRepos()
    })

    // Wait for the repo to appear and fetch its worktrees
    await page.evaluate(async () => {
      const store = window.__store
      if (!store) {
        return
      }

      const repos = store.getState().repos
      for (const repo of repos) {
        await store.getState().fetchWorktrees(repo.id)
      }
    })

    // Wait for workspaceSessionReady to become true
    await page.waitForFunction(
      () => {
        const store = window.__store
        return store?.getState().workspaceSessionReady === true
      },
      null,
      { timeout: 30_000 }
    )

    // Re-activate the test repo's primary worktree after session hydration.
    // Why: workspaceSessionReady restoration can overwrite activeWorktreeId
    // after earlier setup calls. Selecting it here ensures every test starts on
    // the seeded repo instead of the "Select a worktree" empty state.
    await page.evaluate((repoPath: string) => {
      const store = window.__store
      if (!store) {
        return
      }

      const state = store.getState()
      const allWorktrees = Object.values(state.worktreesByRepo).flat()
      const testWorktree = allWorktrees.find(
        (worktree) => worktree.path === repoPath || worktree.path.startsWith(repoPath)
      )
      if (testWorktree) {
        state.setActiveWorktree(testWorktree.id)
      }
    }, testRepoPath)

    // Best-effort seed of a baseline terminal tab when a fresh isolated
    // profile has none yet.
    // Why: terminal-focused suites call ensureTerminalVisible(), which does the
    // authoritative wait. The shared fixture itself should not block non-
    // terminal suites on tab creation timing.
    await page.evaluate(() => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      if (!state.activeWorktreeId) {
        return
      }
      const tabs = state.tabsByWorktree[state.activeWorktreeId] ?? []
      if (tabs.length === 0) {
        state.createTab(state.activeWorktreeId)
      }
    })

    await provideFixture(page)
  },

  // Test-scoped: each test gets the shared page
  orcaPage: async ({ sharedPage }, provideFixture) => {
    await provideFixture(sharedPage)
  },
})

export { expect } from '@stablyai/playwright-test'
