/**
 * Two-launch Electron helper for restart-persistence tests.
 *
 * Why: the default `orcaPage` fixture creates a fresh `userDataDir` per test
 * and deletes it on close, which is incompatible with a test that needs to
 * quit the app and relaunch against the *same* on-disk state. This helper
 * owns the shared userDataDir and gives each caller an `app`+`page` pair
 * wired to it.
 */

import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import { execSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './electron-process-shutdown'

type LaunchedOrca = {
  app: ElectronApplication
  page: Page
}

type RestartSession = {
  userDataDir: string
  launch: () => Promise<LaunchedOrca>
  /** Gracefully close a launch, letting beforeunload flush session state. */
  close: (app: ElectronApplication) => Promise<void>
  /** Remove the shared userDataDir after the test is done. */
  dispose: () => Promise<void>
}

function shouldLaunchHeadful(testInfo: TestInfo): boolean {
  return testInfo.project.metadata.orcaHeadful === true
}

function launchEnv(userDataDir: string, headful: boolean): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  return {
    ...cleanEnv,
    NODE_ENV: 'development',
    ORCA_E2E_USER_DATA_DIR: userDataDir,
    ...(headful ? { ORCA_E2E_HEADFUL: '1' } : { ORCA_E2E_HEADLESS: '1' })
  }
}

/**
 * Create a restart session tied to a persistent userDataDir.
 *
 * Why: keep the launch wiring identical to the shared fixture (mainPath,
 * env stripping, headful toggle) so behavior differences between fixtures
 * don't leak in as false positives for persistence bugs.
 */
export function createRestartSession(testInfo: TestInfo): RestartSession {
  const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-restart-'))
  const headful = shouldLaunchHeadful(testInfo)

  // Why: this helper bypasses the shared `electronApp` fixture, so it must
  // seed the same dismissed onboarding state or the full-screen overlay covers
  // both launches and obscures restart failures.
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(
      {
        settings: {
          telemetry: {
            optedIn: true,
            installId: '00000000-0000-4000-8000-000000000000',
            existedBeforeTelemetryRelease: false
          }
        },
        onboarding: {
          closedAt: 1,
          outcome: 'completed',
          lastCompletedStep: 4
        }
      },
      null,
      2
    )}\n`
  )

  const launch = async (): Promise<LaunchedOrca> => {
    const app = await electron.launch({
      args: [mainPath],
      env: launchEnv(userDataDir, headful)
    })
    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
    return { app, page }
  }

  const close = async (app: ElectronApplication): Promise<void> => {
    await closeElectronAppForE2E(app)
  }

  const dispose = async (): Promise<void> => {
    await cleanupE2EDaemons(userDataDir)
    if (existsSync(userDataDir)) {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  return { userDataDir, launch, close, dispose }
}

/**
 * Attach a repo to the running renderer and wait until a terminal tab is
 * active on its worktree. Matches the shared fixture's setup path so the
 * first-launch state lines up with what real users persist.
 */
export async function attachRepoAndOpenTerminal(page: Page, repoPath: string): Promise<string> {
  if (!isValidGitRepo(repoPath)) {
    throw new Error(`attachRepoAndOpenTerminal: ${repoPath} is not a git repo`)
  }

  await page.evaluate(async (repoPath) => {
    await window.api.repos.add({ path: repoPath })
  }, repoPath)

  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      return
    }
    await store.getState().fetchRepos()
  })

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

  await page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    { timeout: 30_000 }
  )

  // Why: fetchWorktrees() is async. Awaiting the outer page.evaluate returns
  // before the Zustand worktree slice has observed the hydrated state, so a
  // single evaluate() that reads worktreesByRepo can see an empty map. Poll
  // the store until *any* worktree shows up, then pick the one that matches
  // our seeded repo. Matching by basename is sufficient because each test
  // run uses a unique tmp-dir suffix, and it avoids symlink-canonicalization
  // mismatches between the path we pass in and the one the store records.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const store = window.__store
          if (!store) {
            return false
          }
          return Object.values(store.getState().worktreesByRepo).flat().length > 0
        }),
      {
        timeout: 15_000,
        message: 'attachRepoAndOpenTerminal: seeded worktree never surfaced in the store'
      }
    )
    .toBe(true)

  const repoBasename = path.basename(repoPath)
  const worktreeId = await page.evaluate((repoBasename: string) => {
    const store = window.__store
    if (!store) {
      return null
    }
    const state = store.getState()
    const allWorktrees = Object.values(state.worktreesByRepo).flat()
    // Why: the primary worktree lives at the repo root, so its path ends with
    // the repo directory name. The secondary worktree is a sibling directory
    // and will not match this suffix. This gives us the primary deterministically
    // without depending on boolean fields on the worktree record.
    const primary =
      allWorktrees.find(
        (worktree) =>
          worktree.path
            .split(/[\\/]+/)
            .filter(Boolean)
            .pop() === repoBasename
      ) ?? allWorktrees[0]
    if (!primary) {
      return null
    }
    state.setActiveWorktree(primary.id)
    return primary.id
  }, repoBasename)

  if (!worktreeId) {
    throw new Error('attachRepoAndOpenTerminal: test repo did not surface in the store')
  }

  return worktreeId
}

function isValidGitRepo(repoPath: string): boolean {
  if (!repoPath || !existsSync(repoPath)) {
    return false
  }
  try {
    return (
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: repoPath,
        stdio: 'pipe',
        encoding: 'utf8'
      }).trim() === 'true'
    )
  } catch {
    return false
  }
}
