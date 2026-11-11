// Give each test an isolated Electron profile and fixture repo; globalSetup builds the E2E output first.

import {
  test as base,
  expect as playwrightExpect,
  _electron as electron,
  type Page,
  type ElectronApplication,
  type TestInfo
} from '@stablyai/playwright-test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeElectronAppForE2E } from './electron-process-shutdown'
import { recordElectronShutdownTiming } from './electron-shutdown-timing'
import { getOrcaElectronLaunchArgs } from './electron-launch-args'
import { retryTransientMainEvaluate } from './electron-main-evaluate-retry'
import { getE2ECompletedOnboardingProfile } from './e2e-completed-onboarding-profile'
import {
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
} from './electron-home-isolation'
import {
  createSeededTestRepo,
  isValidGitRepo,
  provideWorkerTestRepository
} from './seeded-test-repo'

type OrcaTestFixtures = {
  electronApp: ElectronApplication
  registerPostElectronShutdownCleanup: (cleanup: () => Promise<void>) => void
  sharedPage: Page
  orcaPage: Page
  // Dismiss pointer-blocking onboarding by default; onboarding specs explicitly opt out.
  dismissOnboarding: boolean
  // Seed a ready project unless a first-run golden needs the zero-project path.
  seedTestRepo: boolean
  seededRepoPath: string
  // Synthetic-list specs need only the primary checkout; switching specs keep the two-row default.
  minimumSeededWorktreeCount: number
  // Scope launch env to each test; module-level process.env leaks between reused Playwright workers.
  orcaAppExtraEnv: Record<string, string>
  // Prepend test-local Chromium switches before the app entry so they reach Chromium without leaking to later specs.
  orcaAppExtraArgs: string[]
  // Keep PATH/token overrides fixture-owned so specs cannot alter the user’s shell or running Orca.
  launchEnv: NodeJS.ProcessEnv
}

type OrcaWorkerFixtures = {
  /** Absolute path to this worker's disposable test git repo. */
  testRepoPath: string
}

// Warn about invalid slowMo once per worker rather than once per test.
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
  const started = performance.now()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
      recordElectronShutdownTiming('profile-removal', started)
      return
    } catch (error) {
      if (attempt === 4) {
        throw error
      }
      // Windows profile handles may outlive process exit; retry removal without masking the flow result.
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
}

function shouldLaunchHeadful(testInfo: TestInfo): boolean {
  // Allow isolated manual observation without retagging every spec.
  if (process.env.ORCA_E2E_FORCE_HEADFUL === '1') {
    return true
  }
  return testInfo.project.metadata.orcaHeadful === true
}

// Expose gated log forwarding to specs that own their own app lifecycle.
export function forwardElectronProcessLogs(app: ElectronApplication, testInfo: TestInfo): void {
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

// Use fresh per-test apps/profiles so persistence cannot leak state between specs.
export const test = base.extend<OrcaTestFixtures, OrcaWorkerFixtures>({
  // Auto: restart-only specs also read the published path without requesting an app fixture.
  testRepoPath: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
    async ({}, provideFixture) => {
      await provideWorkerTestRepository(provideFixture)
    },
    { scope: 'worker', auto: true }
  ],

  // Run path cleanup after Electron and detached daemons release Windows worktree handles.
  registerPostElectronShutdownCleanup: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
    async ({}, provideFixture) => {
      const cleanups: (() => Promise<void>)[] = []
      await provideFixture((cleanup) => cleanups.push(cleanup))
      for (const cleanup of cleanups.toReversed()) {
        await cleanup()
      }
    },
    { scope: 'test' }
  ],

  electronApp: async (
    {
      dismissOnboarding,
      launchEnv,
      orcaAppExtraEnv,
      orcaAppExtraArgs,
      registerPostElectronShutdownCleanup
    },
    provideFixture,
    testInfo
  ) => {
    // Depend on cleanup registration so its finalizer runs after Electron releases watchers, terminals and daemons.
    void registerPostElectronShutdownCleanup
    const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-userdata-'))

    if (dismissOnboarding) {
      // Seed completed onboarding; an empty profile implies an existing-user cohort and can show a telemetry overlay.
      writeFileSync(
        path.join(userDataDir, 'orca-data.json'),
        `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
      )
    }
    const headful = shouldLaunchHeadful(testInfo)
    // Strip ELECTRON_RUN_AS_NODE or Node rejects Playwright’s remote-debugging switch before launch.
    const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
    void _unused
    const homeIsolation = createElectronHomeIsolation({
      inheritedEnv: cleanEnv,
      launchEnv,
      extraEnv: orcaAppExtraEnv,
      userDataDir
    })
    // Use slowMo only for deliberate observation on an isolated display.
    const slowMo = ORCA_E2E_SLOWMO_MS
    // Record video for Electron replay; create outputDir up front or Windows may silently drop recordings.
    const recordVideoDir = process.env.ORCA_E2E_RECORD_VIDEO === '1' ? testInfo.outputDir : null
    if (recordVideoDir) {
      mkdirSync(recordVideoDir, { recursive: true })
    }
    const app = await electron.launch({
      args: [...orcaAppExtraArgs, ...getOrcaElectronLaunchArgs(mainPath, headful)],
      ...(slowMo > 0 ? { slowMo } : {}),
      ...(recordVideoDir ? { recordVideo: { dir: recordVideoDir } } : {}),
      // Use development/E2E helpers inside an isolated profile; background launch policy keeps automated desktop windows hidden.
      env: {
        ...homeIsolation.env,
        NODE_ENV: 'development',
        ...(headful ? { ORCA_E2E_HEADFUL: '1' } : { ORCA_E2E_HEADLESS: '1' })
      }
    })
    forwardElectronProcessLogs(app, testInfo)
    try {
      const resolvedHome = await retryTransientMainEvaluate(() =>
        app.evaluate(({ app }) => app.getPath('home'))
      )
      assertElectronResolvedIsolatedHome(resolvedHome, homeIsolation)
    } catch (error) {
      await closeElectronAppForE2E(app, { cleanupDaemonsForUserDataDir: userDataDir })
      await removeUserDataDirAfterShutdown(userDataDir)
      throw error
    }
    await provideFixture(app)
    // Await process-tree shutdown; Playwright close may settle before Electron/PTy descendants exit.
    await closeElectronAppForE2E(app, { cleanupDaemonsForUserDataDir: userDataDir })
    await removeUserDataDirAfterShutdown(userDataDir)
  },

  dismissOnboarding: [true, { option: true }],
  seedTestRepo: [true, { option: true }],
  // Test-scoped so generation scenarios can isolate Git indexes and remotes.
  seededRepoPath: async ({ testRepoPath }, provideFixture) => {
    await provideFixture(testRepoPath)
  },
  minimumSeededWorktreeCount: [2, { option: true }],
  launchEnv: [{}, { option: true }],
  orcaAppExtraEnv: [{}, { option: true }],
  orcaAppExtraArgs: [[], { option: true }],

  sharedPage: async (
    { electronApp, minimumSeededWorktreeCount, seedTestRepo, seededRepoPath },
    provideFixture
  ) => {
    // Allow the full budget for first-window creation on cold isolated profiles.
    const page = await electronApp.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')

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

    const repoPath = isValidGitRepo(seededRepoPath) ? seededRepoPath : createSeededTestRepo()

    // Use repos.add IPC to exercise the same discovery path as Add Project.
    const seededRepoId = await page.evaluate(async (repoPath) => {
      const result = await window.api.repos.add({ path: repoPath })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo.id
    }, repoPath)

    // Poll through the concurrent repos:changed refresh, whose generation can supersede this fetch.
    await playwrightExpect
      .poll(
        () =>
          page.evaluate(async (repoId) => {
            const store = window.__store
            if (!store) {
              return false
            }
            await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
            const repo = store.getState().repos.find((candidate) => candidate.id === repoId)
            if (!repo) {
              return false
            }
            // Show the fixture’s external Git worktrees, which newly added repos hide by default.
            await store.getState().updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
            return true
          }, seededRepoId),
        {
          timeout: 30_000,
          message: `Expected e2e repo to be loaded: ${repoPath}`
        }
      )
      .toBe(true)

    // Hydration can replace the execution context; tolerate this preliminary fetch because the later worktree poll is authoritative.
    await page
      .evaluate(async (repoId) => {
        const store = window.__store
        if (!store) {
          return
        }
        await store.getState().fetchWorktrees(repoId)
      }, seededRepoId)
      .catch(() => false)

    await playwrightExpect
      .poll(
        () =>
          page.evaluate(async (repoId) => {
            const store = window.__store
            if (!store) {
              return 0
            }
            await store.getState().fetchWorktrees(repoId)
            return store.getState().worktreesByRepo[repoId]?.length ?? 0
          }, seededRepoId),
        {
          timeout: 30_000,
          message: 'seeded e2e worktrees did not load'
        }
      )
      .toBeGreaterThanOrEqual(minimumSeededWorktreeCount)

    await page.waitForFunction(
      () => {
        const store = window.__store
        return store?.getState().workspaceSessionReady === true
      },
      null,
      { timeout: 30_000 }
    )

    // Reactivate after hydration so restored state cannot overwrite the fixture’s chosen project.
    await page.evaluate((repoId: string) => {
      const store = window.__store
      if (!store) {
        return
      }

      const state = store.getState()
      // Use provider identity rather than Windows-sensitive path string comparisons.
      const testWorktree = state.worktreesByRepo[repoId]?.find(
        (worktree) => worktree.isMainWorktree
      )
      if (testWorktree) {
        state.setActiveWorktree(testWorktree.id)
      }
    }, seededRepoId)

    // Seed a terminal without blocking nonterminal specs; terminal suites own their readiness wait.
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

  orcaPage: async ({ sharedPage }, provideFixture) => {
    await provideFixture(sharedPage)
  }
})

export { expect } from '@stablyai/playwright-test'
