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

import {
  test as base,
  expect as playwrightExpect,
  _electron as electron,
  type Page,
  type ElectronApplication,
  type TestInfo
} from '@stablyai/playwright-test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { TEST_REPO_PATH_FILE } from '../global-setup'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './electron-process-shutdown'
import { getOrcaElectronLaunchArgs } from './electron-launch-args'
import { getE2ECompletedOnboardingProfile } from './e2e-completed-onboarding-profile'

type OrcaTestFixtures = {
  electronApp: ElectronApplication
  sharedPage: Page
  orcaPage: Page
  // Why: every fresh userData dir paints the first-launch onboarding overlay
  // (closedAt=null), which is `fixed inset-0 z-[100]` and intercepts pointer
  // events for every other test. Dismiss it by default; onboarding.spec.ts
  // opts out via `test.use({ dismissOnboarding: false })`.
  dismissOnboarding: boolean
  // Why: most E2E specs need a ready project before assertions start. Golden
  // first-run specs opt out so they can prove the zero-project onboarding path.
  seedTestRepo: boolean
  // Why: a few IPC repro specs need to launch the Electron app with a scoped
  // PATH/token environment. Keep this fixture-owned so tests never mutate the
  // developer's shell or already-running Orca instance.
  launchEnv: NodeJS.ProcessEnv
}

type OrcaWorkerFixtures = {
  /** Absolute path to the test git repo created by globalSetup. */
  testRepoPath: string
}

// Why: parse + warn at module scope so a bad ORCA_E2E_SLOWMO_MS value logs once
// per worker instead of once per test (otherwise hundreds of lines per CI run).
const ORCA_E2E_SLOWMO_MS_RAW = process.env.ORCA_E2E_SLOWMO_MS
const ORCA_E2E_SLOWMO_MS = ((): number => {
  if (ORCA_E2E_SLOWMO_MS_RAW === undefined) {
    return 0
  }
  const parsed = Number(ORCA_E2E_SLOWMO_MS_RAW)
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[orca-e2e] ORCA_E2E_SLOWMO_MS="${ORCA_E2E_SLOWMO_MS_RAW}" is not a number; ignoring (using 0).`
    )
    return 0
  }
  return Math.max(parsed, 0)
})()

async function removeUserDataDirAfterShutdown(userDataDir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) {
        throw error
      }
      // Why: Windows can briefly keep Electron profile files locked after the
      // process exits; retrying avoids turning a passed flow into teardown noise.
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
}

function shouldLaunchHeadful(testInfo: TestInfo): boolean {
  // Why: ORCA_E2E_FORCE_HEADFUL lets a developer watch any spec in a real
  // window without retagging it `@headful` or switching projects.
  if (process.env.ORCA_E2E_FORCE_HEADFUL === '1') {
    return true
  }
  return testInfo.project.metadata.orcaHeadful === true
}

function forwardElectronProcessLogs(app: ElectronApplication, testInfo: TestInfo): void {
  if (process.env.ORCA_E2E_FORWARD_APP_LOGS !== '1') {
    return
  }

  const child = app.process()
  const prefix = `[electron:${testInfo.title}]`
  child.stdout?.on('data', (chunk: Buffer) => {
    console.log(`${prefix} stdout: ${chunk.toString().trimEnd()}`)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    console.error(`${prefix} stderr: ${chunk.toString().trimEnd()}`)
  })
  child.on('exit', (code, signal) => {
    console.log(`${prefix} exit: code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  })
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

function createSeededTestRepo(): string {
  // Why: realpathSync so the seeded path matches the store's repo.path on
  // macOS, where os.tmpdir() (/var/...) symlinks to /private/var/... and the
  // app canonicalizes repo.path via `git rev-parse --show-toplevel` on add.
  const testRepoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-repo-')))

  execSync('git init', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git config user.email "e2e@test.local"', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git config user.name "E2E Test"', { cwd: testRepoDir, stdio: 'pipe' })

  writeFileSync(
    path.join(testRepoDir, 'README.md'),
    '# Orca E2E Test Repo\n\nThis repo was created automatically for Playwright tests.\n'
  )
  writeFileSync(path.join(testRepoDir, 'CLAUDE.md'), '# CLAUDE.md\n\nTest instructions for E2E.\n')
  writeFileSync(
    path.join(testRepoDir, 'package.json'),
    `${JSON.stringify({ name: 'orca-e2e-test', version: '0.0.0', private: true }, null, 2)}\n`
  )
  writeFileSync(path.join(testRepoDir, '.gitignore'), 'node_modules/\n')
  mkdirSync(path.join(testRepoDir, 'src'), { recursive: true })
  writeFileSync(path.join(testRepoDir, 'src', 'index.ts'), 'export const hello = "world"\n')

  execSync('git add -A', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git commit -m "Initial commit for E2E tests"', { cwd: testRepoDir, stdio: 'pipe' })

  // Why: worker-scoped fixture fallbacks can run in parallel; UUIDs avoid
  // colliding on the same temp repo/worktree when workers start together.
  const worktreeDir = path.join(testRepoDir, '..', `orca-e2e-worktree-${randomUUID()}`)
  execSync(`git worktree add "${worktreeDir}" -b e2e-secondary`, {
    cwd: testRepoDir,
    stdio: 'pipe'
  })

  writeFileSync(TEST_REPO_PATH_FILE, testRepoDir)
  return testRepoDir
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
  testRepoPath: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
    async ({}, provideFixture) => {
      const persistedRepoPath = existsSync(TEST_REPO_PATH_FILE)
        ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
        : ''
      const repoPath = isValidGitRepo(persistedRepoPath)
        ? persistedRepoPath
        : createSeededTestRepo()
      await provideFixture(repoPath)
    },
    { scope: 'worker' }
  ],

  // Test-scoped: one Electron app per test
  electronApp: async ({ dismissOnboarding, launchEnv }, provideFixture, testInfo) => {
    const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-userdata-'))

    if (dismissOnboarding) {
      // Why: onboarding renders a fullscreen `fixed inset-0 z-[100]` overlay
      // when persisted `closedAt` is null, which intercepts pointer events for
      // every other test. Seed a completed-onboarding fresh-install profile:
      // an empty file would make persistence treat the profile as an
      // existing-user upgrade cohort and mount the telemetry notice overlay.
      writeFileSync(
        path.join(userDataDir, 'orca-data.json'),
        `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
      )
    }
    const headful = shouldLaunchHeadful(testInfo)
    // Why: strip ELECTRON_RUN_AS_NODE before spawning. Some host shells (e.g.
    // Orca's own agent runtime) set it so Electron behaves as a plain Node
    // binary. Playwright's _electron.launch passes --remote-debugging-port,
    // which Node rejects with "bad option" and the process exits immediately.
    const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
    void _unused
    // Why: ORCA_E2E_SLOWMO_MS adds a pause between every Playwright action so a
    // developer running with ORCA_E2E_FORCE_HEADFUL=1 can actually watch what
    // the test does. Defaults to 0 (no slowdown) for normal runs.
    const slowMo = ORCA_E2E_SLOWMO_MS
    // Why: ORCA_E2E_RECORD_VIDEO=1 captures a webm of the renderer so a
    // developer can replay the run later — Electron's Playwright trace viewer
    // does not produce DOM snapshots, so video is the only reliable replay.
    // Why: testInfo.outputDir is created lazily by Playwright; on Windows the
    // dir may not exist when the fixture initializes, and Electron silently
    // drops the recording. mkdir up-front so the recorder always has a home.
    const recordVideoDir = process.env.ORCA_E2E_RECORD_VIDEO === '1' ? testInfo.outputDir : null
    if (recordVideoDir) {
      mkdirSync(recordVideoDir, { recursive: true })
    }
    const app = await electron.launch({
      args: getOrcaElectronLaunchArgs(mainPath, headful),
      ...(slowMo > 0 ? { slowMo } : {}),
      ...(recordVideoDir ? { recordVideo: { dir: recordVideoDir } } : {}),
      // Why: keep NODE_ENV=development so window.__store is exposed and
      // dev-only helpers activate. ORCA_E2E_USER_DATA_DIR overrides the usual
      // shared dev profile so every spec gets a clean persistence root.
      // Why: ORCA_E2E_HEADLESS suppresses mainWindow.show() so the app
      // window stays hidden during test runs, avoiding focus stealing and
      // screen clutter. Playwright interacts via CDP regardless.
      // Why: ORCA_E2E_HEADLESS suppresses mainWindow.show() for CI/headless
      // runs. ORCA_E2E_HEADFUL overrides this for tests that need a visible
      // window (e.g. pointer-capture drag tests).
      // Why: local SSH E2E deploys the relay from the dev build output. The
      // Electron app's getAppPath() points at the compiled main bundle in E2E,
      // so pass the repo-root relay path explicitly for this opt-in suite.
      env: {
        ...cleanEnv,
        ...launchEnv,
        NODE_ENV: 'development',
        ORCA_E2E_USER_DATA_DIR: userDataDir,
        ...((process.env.ORCA_E2E_SSH_LOCALHOST === '1' ||
          process.env.ORCA_E2E_SSH_DOCKER === '1') &&
        !cleanEnv.ORCA_RELAY_PATH
          ? { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
          : {}),
        ...(headful ? { ORCA_E2E_HEADFUL: '1' } : { ORCA_E2E_HEADLESS: '1' })
      }
    })
    forwardElectronProcessLogs(app, testInfo)
    await provideFixture(app)
    // Why: the Playwright close promise can settle before all Electron and PTY
    // descendants are gone in CI; worker teardown then hangs on open handles.
    await closeElectronAppForE2E(app)
    await cleanupE2EDaemons(userDataDir)
    await removeUserDataDirAfterShutdown(userDataDir)
  },

  // Default: dismiss the onboarding overlay so it doesn't intercept clicks.
  dismissOnboarding: [true, { option: true }],
  seedTestRepo: [true, { option: true }],
  launchEnv: [{}, { option: true }],

  // Test-scoped: grab the first BrowserWindow, add the test repo, and wait
  // until the session is fully ready with a worktree active.
  sharedPage: async ({ electronApp, seedTestRepo, testRepoPath }, provideFixture) => {
    // Why: the Electron app may take a while to create the first window,
    // especially on cold start with no prior dev userData. Isolated per-test
    // profiles make late-suite launches slower, so use the full test budget.
    const page = await electronApp.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')

    // Wait for the store to be available
    await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })

    if (!seedTestRepo) {
      await page.waitForFunction(
        () => window.__store?.getState().workspaceSessionReady === true,
        null,
        { timeout: 30_000 }
      )
      await provideFixture(page)
      return
    }

    const repoPath = isValidGitRepo(testRepoPath) ? testRepoPath : createSeededTestRepo()

    // Add the test repo via the IPC bridge
    // Why: calling window.api.repos.add() goes through the same code path as
    // the "Add Project" UI flow, ensuring worktrees are fetched and the session
    // initializes properly.
    await page.evaluate(async (repoPath) => {
      await window.api.repos.add({ path: repoPath })
    }, repoPath)

    // Fetch repos in the renderer store so it picks up the new repo, then opt
    // this disposable repo into showing external worktrees.
    // Why: repos.add() fires a repos:changed echo that triggers a *concurrent*
    // fetchRepos() in the renderer; the store's generation guard can then drop
    // this awaited fetch's result, leaving `repos` briefly stale. Poll the
    // public fetch path until the repo lands instead of asserting on the first
    // tick (mirrors the seeded-worktree poll below). updateRepo is idempotent,
    // so running it once the repo appears is safe across poll ticks.
    await playwrightExpect
      .poll(
        () =>
          page.evaluate(async (repoPath) => {
            const store = window.__store
            if (!store) {
              return false
            }
            await store.getState().fetchRepos()
            const repo = store.getState().repos.find((candidate) => candidate.path === repoPath)
            if (!repo) {
              return false
            }
            // Why: the fixture deliberately creates external Git worktrees. New
            // repos hide those by default after the visibility rollout.
            await store.getState().updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
            return true
          }, repoPath),
        {
          timeout: 30_000,
          message: `Expected e2e repo to be loaded: ${repoPath}`
        }
      )
      .toBe(true)

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

    // Why: parallel specs mutate real git worktrees in the shared fixture repo.
    // A first scan can briefly return no rows while git holds a worktree lock,
    // so poll the public fetch path until the seeded primary + secondary load.
    await playwrightExpect
      .poll(
        () =>
          page.evaluate(async (repoPath) => {
            const store = window.__store
            if (!store) {
              return 0
            }
            const repo = store.getState().repos.find((candidate) => candidate.path === repoPath)
            if (!repo) {
              return 0
            }
            await store.getState().fetchWorktrees(repo.id)
            return store.getState().worktreesByRepo[repo.id]?.length ?? 0
          }, repoPath),
        {
          timeout: 30_000,
          message: 'seeded e2e worktrees did not load'
        }
      )
      .toBeGreaterThanOrEqual(2)

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
    }, repoPath)

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
  }
})

export { expect } from '@stablyai/playwright-test'
