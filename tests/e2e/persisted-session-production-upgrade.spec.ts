import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'

import { forwardElectronProcessLogs, test, expect } from './helpers/orca-app'

import { createRestartSession } from './helpers/orca-restart'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { getElectronIsolatedKeychainArgs } from './helpers/electron-launch-args'
import {
  areSameHomePath,
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
} from './helpers/electron-home-isolation'
import { waitForSessionReady } from './helpers/store'
import { openProfileStateDatabaseReadOnly } from '../../src/main/persistence/profile-state/database/profile-state-database'
import { readProfileStateSnapshot } from '../../src/main/persistence/profile-state/documents/profile-state-documents'
import { acquireProfileStateMaintenance } from '../../src/main/persistence/profile-state/access/profile-state-access'
import { rollbackProfileState } from '../../src/main/persistence/profile-state/recovery/profile-state-recovery-command'
import { profileStateJsonExportPaths } from '../../src/main/persistence/profile-state/legacy-json/profile-state-export-path'
import type { ProfileStateRecoverySelector } from '../../src/shared/profile-state-recovery-command'

// This fixture captures a legacy production schema boundary; the test runs the current build.

const PACKAGED_OLD_EXECUTABLE_ENV = 'ORCA_PROFILE_STATE_PACKAGED_OLD_EXECUTABLE'

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

function readLegacyJsonArtifacts(userDataDir: string): Record<string, string> {
  const profileDirectory = path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID)
  const dataPath = path.join(profileDirectory, 'orca-data.json')
  return Object.fromEntries(
    [dataPath, ...profileStateJsonExportPaths(dataPath)]
      .filter((file) => existsSync(file))
      .map((file) => [path.basename(file), readFileSync(file, 'utf8')])
  )
}

function restoreLegacyProfileJson(
  userDataDir: string,
  selector: ProfileStateRecoverySelector = { kind: 'current-json' }
) {
  const maintenance = acquireProfileStateMaintenance(userDataDir)
  try {
    return rollbackProfileState(userDataDir, selector, maintenance)
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
                const timeout = setTimeout<[]>(() => resolve(false), 2_000)
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
        // Allow old packaged builds extra first-run bootstrap time while the candidate daemon is shutting down.
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

// oxlint-disable-next-line no-empty-pattern -- This mixed-version test owns its Electron launches.

test('real packaged old build reads the latest explicit JSON rollback before candidate re-import', async ({
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
    await waitForSessionReady(candidateLaunch.page)
    const retainedJson = readLegacyJsonArtifacts(session.userDataDir)
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
    expect(readLegacyJsonArtifacts(session.userDataDir)).toEqual(retainedJson)

    const databasePath = path.join(
      session.userDataDir,
      'profiles',
      DEFAULT_LOCAL_ORCA_PROFILE_ID,
      'profile-state.db'
    )
    expect(existsSync(databasePath)).toBe(true)
    await cleanupE2EDaemons(session.userDataDir)
    const rollback = restoreLegacyProfileJson(session.userDataDir, { kind: 'latest-json' })
    expect(rollback.revision).toBeGreaterThan(1)
    expect(existsSync(databasePath)).toBe(false)

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
    const olderBuildMarker = 21
    await oldLaunch.page.evaluate(async (terminalFontSize) => {
      await window.api.settings.set({ terminalFontSize })
    }, olderBuildMarker)
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
      .toBe(olderBuildMarker)
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

test('fails closed when a packaged old build mutates JSON outside an explicit rollback', async ({
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
    const candidateExecutable = await candidateApp.evaluate(() => process.execPath)
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
    // Deliberately bypass rollback to reproduce an unsupported mixed-authority profile.
    materializeLegacyProfileJson(session.userDataDir)
    const compatibilityPath = path.join(profileDirectory, 'orca-data.json')
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

    const refused = await session.launchUntilExit(candidateExecutable)
    expect(refused, refused.stderr).toMatchObject({ code: 1, signal: null, timedOut: false })
    expect(refused.stderr).toContain(
      'both JSON and SQLite storage without a matching acceptance marker'
    )
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
    const candidateExecutable = await app.evaluate(() => process.execPath)
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
    const refused = await session.launchUntilExit(candidateExecutable)
    expect(refused, refused.stderr).toMatchObject({ code: 1, signal: null, timedOut: false })
    expect(refused.stderr).toContain('cannot safely open the active profile')
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
