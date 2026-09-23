import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { PTY_SESSION_ID_SEPARATOR } from '../../src/shared/pty-session-id-format'
import { forwardElectronProcessLogs, test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { getElectronIsolatedKeychainArgs } from './helpers/electron-launch-args'
import {
  areSameHomePath,
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
} from './helpers/electron-home-isolation'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { openProfileStateDatabaseReadOnly } from '../../src/main/persistence/profile-state/profile-state-database'
import { readProfileStateSnapshot } from '../../src/main/persistence/profile-state/profile-state-documents'
import { ProfileStateSqliteAuthority } from '../../src/main/persistence/profile-state/profile-state-sqlite-authority'
import { acquireProfileStateMaintenance } from '../../src/main/persistence/profile-state/profile-state-access'
import { restoreProfileStateJsonExport } from '../../src/main/persistence/profile-state/profile-state-recovery'
import {
  discoverActivePtyId,
  execInTerminal,
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'persisted-sessions',
  'legacy-workspace-session-daemon-terminal.json'
)
// This fixture captures a legacy production schema boundary; the test runs the current build.
const RESTORED_TITLE = 'Production agent session'
const PACKAGED_OLD_EXECUTABLE_ENV = 'ORCA_PROFILE_STATE_PACKAGED_OLD_EXECUTABLE'

type FixtureSession = {
  _fixtureProvenance?: unknown
  activeRepoId: string
  activeWorktreeId: string
  tabsByWorktree: Record<string, { ptyId: string; worktreeId: string }[]>
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> }>
  activeWorktreeIdsOnShutdown?: string[]
  activeTabIdByWorktree?: Record<string, string>
}

function installProductionSessionFixture(
  userDataDir: string,
  repoId: string,
  worktreeId: string,
  ptyId: string
): void {
  const profilePath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureSession
  const fixtureTabs = fixture.tabsByWorktree.__WORKTREE_ID__
  const fixtureLayout = fixture.terminalLayoutsByTabId['production-agent-tab']
  if (!fixtureTabs || !fixtureLayout) {
    throw new Error('Production session fixture is missing its terminal records')
  }
  delete fixture._fixtureProvenance
  fixture.activeRepoId = repoId
  fixture.activeWorktreeId = worktreeId
  fixture.tabsByWorktree = {
    [worktreeId]: fixtureTabs.map((tab) => ({
      ...tab,
      ptyId,
      worktreeId
    }))
  }
  fixtureLayout.ptyIdsByLeafId = {
    'pane:production-agent': ptyId
  }
  fixture.activeWorktreeIdsOnShutdown = [worktreeId]
  fixture.activeTabIdByWorktree = { [worktreeId]: 'production-agent-tab' }
  profile.workspaceSession = fixture
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`)
}

function materializeLegacyProfileJson(userDataDir: string): void {
  const profileDirectory = path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)
  const databasePath = path.join(profileDirectory, 'profile-state.db')
  const dataPath = path.join(profileDirectory, 'orca-data.json')
  const opened = openProfileStateDatabaseReadOnly(databasePath, DEFAULT_LOCAL_ORCA_PROFILE_ID)
  try {
    writeFileSync(dataPath, `${readProfileStateSnapshot(opened.db).json}\n`)
  } finally {
    opened.db.close()
  }
}

function publishLegacyCompatibilitySnapshot(userDataDir: string): string {
  const profileDirectory = path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)
  const dataPath = path.join(profileDirectory, 'orca-data.json')
  const databasePath = path.join(profileDirectory, 'profile-state.db')
  const authority = new ProfileStateSqliteAuthority(databasePath, DEFAULT_LOCAL_ORCA_PROFILE_ID)
  try {
    authority.readSerializedState()
    const revision = authority.writeJsonCompatibilityExport(dataPath)
    if (revision === undefined) {
      throw new Error('Expected the candidate profile to have a persisted revision')
    }
    return dataPath
  } finally {
    authority.close()
  }
}

function restoreLegacyProfileJson(userDataDir: string): void {
  const profileDirectory = path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)
  const databasePath = path.join(profileDirectory, 'profile-state.db')
  const dataFile = path.join(profileDirectory, 'orca-data.json')
  const maintenance = acquireProfileStateMaintenance(userDataDir)
  try {
    restoreProfileStateJsonExport({
      maintenance,
      databasePath,
      dataFile,
      exportPath: dataFile,
      profileId: DEFAULT_LOCAL_ORCA_PROFILE_ID
    })
  } finally {
    maintenance.release()
  }
}

async function launchPackagedOldProfile(args: {
  executablePath: string
  userDataDir: string
  testInfo: TestInfo
}): Promise<{ app: ElectronApplication; page: Page }> {
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const homeIsolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir: args.userDataDir
  })
  const app = await electron.launch({
    executablePath: args.executablePath,
    args: [...getElectronIsolatedKeychainArgs(), `--user-data-dir=${args.userDataDir}`],
    env: {
      ...homeIsolation.env,
      NODE_ENV: 'production',
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_E2E_HEADLESS: '1',
      ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1'
    }
  })
  forwardElectronProcessLogs(app, args.testInfo)
  try {
    assertElectronResolvedIsolatedHome(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('home')),
      homeIsolation
    )
    const resolvedUserDataDir = await app.evaluate(({ app: electronApp }) =>
      electronApp.getPath('userData')
    )
    if (!areSameHomePath(resolvedUserDataDir, args.userDataDir)) {
      throw new Error('Packaged old build escaped the disposable user-data boundary')
    }
    await app.firstWindow({ timeout: 120_000 })
    let apiPage: Page | undefined
    await expect
      .poll(
        async () => {
          for (const candidate of app.windows()) {
            const hasSettingsApi = await Promise.race([
              candidate.evaluate(() => Boolean(window.api?.settings?.get)).catch(() => false),
              new Promise<boolean>((resolve) => {
                const timeout = setTimeout(() => resolve(false), 2_000)
                timeout.unref?.()
              })
            ])
            if (hasSettingsApi) {
              apiPage = candidate
              return true
            }
          }
          return false
        },
        // Older packaged builds can spend longer in their first-run renderer bootstrap
        // while the candidate daemon from the same test worker is shutting down.
        { timeout: 120_000 }
      )
      .toBe(true)
    if (!apiPage) {
      throw new Error('Packaged old build did not expose its renderer API')
    }
    await apiPage.waitForLoadState('domcontentloaded')
    return { app, page: apiPage }
  } catch (error) {
    await closeElectronAppForE2E(app).catch(() => {})
    throw error
  }
}

async function expectProductionSessionRestored(
  page: Page,
  expected: { marker: string; ptyId: string; repoId: string; worktreeId: string }
): Promise<void> {
  await waitForSessionReady(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
  await waitForTerminalOutput(page, expected.marker, 30_000)

  await expect(
    page.locator('[data-testid="sortable-tab"]').filter({ hasText: RESTORED_TITLE })
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-testid="sortable-tab"]')).toHaveCount(1)
  await expect(page.locator('.xterm').first()).toBeVisible()
  expect(await discoverActivePtyId(page)).toBe(expected.ptyId)
  expect(await getTerminalContent(page)).toContain(expected.marker)
  expect(
    await page.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeRepoId: state?.activeRepoId,
        activeWorktreeId: state?.activeWorktreeId,
        tabIds: state?.activeWorktreeId
          ? state.tabsByWorktree[state.activeWorktreeId]?.map((tab) => tab.id)
          : []
      }
    })
  ).toEqual({
    activeRepoId: expected.repoId,
    activeWorktreeId: expected.worktreeId,
    tabIds: ['production-agent-tab']
  })
}

test('upgrades a legacy daemon session and keeps it stable after relaunch', async (// oxlint-disable-next-line no-empty-pattern -- this upgrade test owns its Electron launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Seeded E2E repository is unavailable')

  const session = createRestartSession(testInfo)
  let oldApp: ElectronApplication | null = null
  let currentApp: ElectronApplication | null = null
  let stableApp: ElectronApplication | null = null

  try {
    const oldLaunch = await session.launch()
    oldApp = oldLaunch.app
    const worktreeId = await attachRepoAndOpenTerminal(oldLaunch.page, repoPath)
    await waitForSessionReady(oldLaunch.page)
    await ensureTerminalVisible(oldLaunch.page)
    await waitForActiveTerminalManager(oldLaunch.page, 30_000)
    await waitForPaneCount(oldLaunch.page, 1, 30_000)

    const ptyId = await discoverActivePtyId(oldLaunch.page)
    expect(ptyId).toContain(PTY_SESSION_ID_SEPARATOR)
    const marker = `PRODUCTION_UPGRADE_${Date.now()}`
    await execInTerminal(oldLaunch.page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(oldLaunch.page, marker)
    const repoId = await oldLaunch.page.evaluate(
      (repoPath) => window.__store?.getState().repos.find((repo) => repo.path === repoPath)?.id,
      repoPath
    )
    if (!repoId) {
      throw new Error('Active repository was unavailable before fixture installation')
    }

    await session.close(oldApp)
    oldApp = null
    // Recreate a pre-cutover profile while retaining its live terminal identity.
    materializeLegacyProfileJson(session.userDataDir)
    installProductionSessionFixture(session.userDataDir, repoId, worktreeId, ptyId)
    await cleanupE2EDaemons(session.userDataDir)
    restoreLegacyProfileJson(session.userDataDir)

    const currentLaunch = await session.launch()
    currentApp = currentLaunch.app
    const expected = { marker, ptyId, repoId, worktreeId }
    await expectProductionSessionRestored(currentLaunch.page, expected)

    await session.close(currentApp)
    currentApp = null

    const stableLaunch = await session.launch()
    stableApp = stableLaunch.app
    await expectProductionSessionRestored(stableLaunch.page, expected)
  } finally {
    for (const app of [stableApp, currentApp, oldApp]) {
      if (app) {
        await session.close(app).catch(() => {})
      }
    }
    await session.dispose()
  }
})

// oxlint-disable-next-line no-empty-pattern -- This mixed-version test owns its Electron launches.
test('restores a JSON compatibility snapshot and migrates it on normal restart', async ({}, testInfo) => {
  test.setTimeout(240_000)

  const session = createRestartSession(testInfo)
  let candidateApp: ElectronApplication | null = null
  let reupgradedApp: ElectronApplication | null = null
  try {
    const candidateLaunch = await session.launch()
    candidateApp = candidateLaunch.app
    await waitForSessionReady(candidateLaunch.page)
    const marker = 17
    await candidateLaunch.page.evaluate(async (terminalFontSize) => {
      const updateSettings = window.__store?.getState().updateSettingsOrThrow
      if (!updateSettings) {
        throw new Error('Candidate renderer did not expose settings persistence')
      }
      await updateSettings({ terminalFontSize })
    }, marker)
    await expect
      .poll(
        () =>
          candidateLaunch.page.evaluate(
            () => window.__store?.getState().settings?.terminalFontSize
          ),
        { timeout: 15_000 }
      )
      .toBe(marker)

    const profileDirectory = path.join(
      session.userDataDir,
      'profiles',
      DEFAULT_LOCAL_ORCA_PROFILE_ID
    )
    const databasePath = path.join(profileDirectory, 'profile-state.db')
    await session.close(candidateApp)
    candidateApp = null
    const dataPath = publishLegacyCompatibilitySnapshot(session.userDataDir)
    expect(existsSync(databasePath)).toBe(true)
    expect(existsSync(dataPath)).toBe(true)

    // Restore the exported JSON, then exercise normal first migration again.
    await cleanupE2EDaemons(session.userDataDir)
    restoreLegacyProfileJson(session.userDataDir)
    expect(existsSync(databasePath)).toBe(false)
    expect(JSON.parse(readFileSync(dataPath, 'utf8')).settings.terminalFontSize).toBe(marker)
    const reupgradedLaunch = await session.launch()
    reupgradedApp = reupgradedLaunch.app
    await waitForSessionReady(reupgradedLaunch.page)
    await expect
      .poll(
        () =>
          reupgradedLaunch.page.evaluate(
            () => window.__store?.getState().settings?.terminalFontSize
          ),
        { timeout: 15_000 }
      )
      .toBe(marker)
    expect(existsSync(databasePath)).toBe(true)
  } finally {
    for (const app of [reupgradedApp, candidateApp]) {
      if (app) {
        await session.close(app).catch(() => {})
      }
    }
    await session.dispose()
  }
})

test('real packaged old build reads compatibility JSON before candidate re-import', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(300_000)
  const executablePath = process.env[PACKAGED_OLD_EXECUTABLE_ENV]
  test.skip(
    !executablePath || !existsSync(executablePath),
    `${PACKAGED_OLD_EXECUTABLE_ENV} must point at an older packaged Orca executable`
  )

  const session = createRestartSession(testInfo)
  let candidateApp: ElectronApplication | null = null
  let oldApp: ElectronApplication | null = null
  let reupgradedApp: ElectronApplication | null = null
  try {
    const candidateLaunch = await session.launch()
    candidateApp = candidateLaunch.app
    const marker = 19
    await candidateLaunch.page.evaluate(async (terminalFontSize) => {
      const updateSettings = window.__store?.getState().updateSettingsOrThrow
      if (!updateSettings) {
        throw new Error('Candidate renderer did not expose settings persistence')
      }
      await updateSettings({ terminalFontSize })
    }, marker)
    await expect
      .poll(() =>
        candidateLaunch.page.evaluate(() => window.__store?.getState().settings?.terminalFontSize)
      )
      .toBe(marker)
    await session.close(candidateApp)
    candidateApp = null

    const databasePath = path.join(
      session.userDataDir,
      'profiles',
      DEFAULT_LOCAL_ORCA_PROFILE_ID,
      'profile-state.db'
    )
    const compatibilityPath = publishLegacyCompatibilitySnapshot(session.userDataDir)
    expect(existsSync(databasePath)).toBe(true)
    expect(existsSync(compatibilityPath)).toBe(true)
    await cleanupE2EDaemons(session.userDataDir)
    // A pre-migration build reads the canonical JSON restored by rollback.
    restoreLegacyProfileJson(session.userDataDir)

    const oldLaunch = await launchPackagedOldProfile({
      executablePath: executablePath!,
      userDataDir: session.userDataDir,
      testInfo
    })
    oldApp = oldLaunch.app
    await expect
      .poll(() => oldLaunch.page.evaluate(() => window.api.settings.get()))
      .toMatchObject({
        terminalFontSize: marker
      })
    await closeElectronAppForE2E(oldApp)
    oldApp = null

    const reupgradedLaunch = await session.launch()
    reupgradedApp = reupgradedLaunch.app
    await expect
      .poll(
        () =>
          reupgradedLaunch.page.evaluate(
            () => window.__store?.getState().settings?.terminalFontSize
          ),
        { timeout: 30_000 }
      )
      .toBe(marker)
    expect(existsSync(databasePath)).toBe(true)
  } finally {
    for (const app of [reupgradedApp, oldApp, candidateApp]) {
      if (app) {
        await closeElectronAppForE2E(app).catch(() => {})
      }
    }
    await session.dispose()
  }
})

test('fails closed when a packaged old build mutates live SQLite compatibility JSON', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(300_000)
  const executablePath = process.env[PACKAGED_OLD_EXECUTABLE_ENV]
  test.skip(
    !executablePath || !existsSync(executablePath),
    `${PACKAGED_OLD_EXECUTABLE_ENV} must point at an older packaged Orca executable`
  )

  const session = createRestartSession(testInfo)
  let candidateApp: ElectronApplication | null = null
  let oldApp: ElectronApplication | null = null
  try {
    const candidateLaunch = await session.launch()
    candidateApp = candidateLaunch.app
    await waitForSessionReady(candidateLaunch.page)
    await candidateLaunch.page.evaluate(async () => {
      const updateSettings = window.__store?.getState().updateSettingsOrThrow
      if (!updateSettings) {
        throw new Error('Candidate renderer did not expose settings persistence')
      }
      await updateSettings({ terminalFontSize: 19 })
    })
    await expect
      .poll(() =>
        candidateLaunch.page.evaluate(() => window.__store?.getState().settings?.terminalFontSize)
      )
      .toBe(19)
    await session.close(candidateApp)
    candidateApp = null

    const profileDirectory = path.join(
      session.userDataDir,
      'profiles',
      DEFAULT_LOCAL_ORCA_PROFILE_ID
    )
    const databasePath = path.join(profileDirectory, 'profile-state.db')
    const compatibilityPath = publishLegacyCompatibilitySnapshot(session.userDataDir)
    expect(existsSync(databasePath)).toBe(true)
    expect(existsSync(compatibilityPath)).toBe(true)

    const oldLaunch = await launchPackagedOldProfile({
      executablePath: executablePath!,
      userDataDir: session.userDataDir,
      testInfo
    })
    oldApp = oldLaunch.app
    await expect
      .poll(() => oldLaunch.page.evaluate(() => window.api.settings.get()))
      .toMatchObject({ terminalFontSize: 19 })
    await oldLaunch.page.evaluate(async () => {
      await window.api.settings.set({ terminalFontSize: 23 })
    })
    await expect
      .poll(() => oldLaunch.page.evaluate(() => window.api.settings.get()))
      .toMatchObject({ terminalFontSize: 23 })
    await closeElectronAppForE2E(oldApp)
    oldApp = null

    const mutatedJson = JSON.parse(readFileSync(compatibilityPath, 'utf8'))
    expect(mutatedJson).toMatchObject({ settings: { terminalFontSize: 23 } })
    expect(existsSync(databasePath)).toBe(true)

    let stderr = ''
    let launchError: unknown
    try {
      await session.launch({
        onStderr: (chunk) => {
          stderr += chunk
        }
      })
    } catch (error) {
      launchError = error
    }
    expect(launchError).toBeDefined()
    expect(stderr).toContain('both JSON and SQLite storage without a matching acceptance marker')
    expect(existsSync(databasePath)).toBe(true)
    const opened = openProfileStateDatabaseReadOnly(databasePath, DEFAULT_LOCAL_ORCA_PROFILE_ID)
    try {
      expect(JSON.parse(readProfileStateSnapshot(opened.db).json)).toMatchObject({
        settings: { terminalFontSize: 19 }
      })
    } finally {
      opened.db.close()
    }
  } finally {
    for (const app of [oldApp, candidateApp]) {
      if (app) {
        await closeElectronAppForE2E(app).catch(() => {})
      }
    }
    await session.dispose()
  }
})

// oxlint-disable-next-line no-empty-pattern -- This recovery test owns its Electron launches.
test('fails closed on a corrupt established SQLite profile and retains recovery evidence', async ({}, testInfo) => {
  test.setTimeout(180_000)

  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const initialLaunch = await session.launch()
    app = initialLaunch.app
    await waitForSessionReady(initialLaunch.page)
    await session.close(app)
    app = null

    const profileDirectory = path.join(
      session.userDataDir,
      'profiles',
      DEFAULT_LOCAL_ORCA_PROFILE_ID
    )
    const dataFile = path.join(profileDirectory, 'orca-data.json')
    const databaseFile = path.join(profileDirectory, 'profile-state.db')
    const retainedExports = readdirSync(profileDirectory).filter((name) =>
      /^orca-data\.json\.sqlite-export\.\d+\.json$/.test(name)
    )
    expect(retainedExports.length).toBeGreaterThan(0)
    const jsonBeforeCorruption = readFileSync(dataFile)

    writeFileSync(databaseFile, 'corrupt profile-state database')
    let stderr = ''
    let launchError: unknown
    try {
      await session.launch({
        onStderr: (chunk) => {
          stderr += chunk
        }
      })
    } catch (error) {
      launchError = error
    }

    expect(launchError).toBeDefined()
    expect(stderr).toContain('cannot safely open the active profile')
    expect(readFileSync(dataFile)).toEqual(jsonBeforeCorruption)
    expect(
      readdirSync(profileDirectory).filter((name) =>
        /^orca-data\.json\.sqlite-export\.\d+\.json$/.test(name)
      )
    ).toEqual(retainedExports)
  } finally {
    if (app) {
      await session.close(app).catch(() => {})
    }
    await session.dispose()
  }
})
