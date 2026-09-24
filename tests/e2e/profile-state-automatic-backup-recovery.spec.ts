import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { runProcess } from '../../src/shared/child-process/run-process'
import { openProfileStateDatabaseReadOnly } from '../../src/main/persistence/profile-state/profile-state-database'
import { readProfileStateSnapshot } from '../../src/main/persistence/profile-state/profile-state-documents'
import { profileStateDatabaseBackups } from '../../src/main/persistence/profile-state/profile-state-backup-path'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import { waitForSessionReady } from './helpers/store'

function readSnapshot(databasePath: string) {
  const opened = openProfileStateDatabaseReadOnly(databasePath, DEFAULT_LOCAL_ORCA_PROFILE_ID)
  try {
    return readProfileStateSnapshot(opened.db)
  } finally {
    opened.db.close()
  }
}

function rollbackProfileBackup(userDataDir: string, backupId: string, executable?: string) {
  const cliIsolation = createElectronHomeIsolation({
    inheritedEnv: process.env,
    launchEnv: { ORCA_USER_DATA_PATH: userDataDir, ORCA_BACKGROUND_LAUNCH: '1' },
    extraEnv: {
      ...(executable
        ? { ORCA_APP_EXECUTABLE: executable, ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT: '1' }
        : {}),
      // Raw development Electron needs the same sandbox opt-out as Playwright.
      ...(process.platform === 'linux' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {})
    },
    userDataDir
  })
  return runProcess({
    program: process.execPath,
    args: [
      path.join(process.cwd(), 'out', 'cli', 'index.js'),
      'profile',
      'state',
      'rollback',
      '--backup',
      backupId,
      '--json'
    ],
    env: cliIsolation.env,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024
  })
}

for (const recoveryRuntime of ['node', 'electron'] as const) {
  // oxlint-disable-next-line no-empty-pattern -- This test owns both hidden Electron launches.
  test(`restores an automatic SQLite backup through the ${recoveryRuntime} CLI after primary corruption`, async ({}, testInfo) => {
    test.setTimeout(180_000)
    const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
    const rootJson = path.join(session.userDataDir, 'orca-data.json')
    const profileDirectory = path.join(
      session.userDataDir,
      'profiles',
      DEFAULT_LOCAL_ORCA_PROFILE_ID
    )
    const databasePath = path.join(profileDirectory, 'profile-state.db')
    const dataFile = path.join(profileDirectory, 'orca-data.json')
    const marker = `automatic-backup-${Date.now()}`
    const recoveryMarker = {
      marker,
      // Exercise native cloning in the Electron recovery process on macOS.
      payload: recoveryRuntime === 'electron' ? 'retained recovery data'.repeat(450_000) : ''
    }
    const seed = getE2ECompletedOnboardingProfile()
    writeFileSync(
      rootJson,
      JSON.stringify({
        ...seed,
        settings: { ...seed.settings, terminalFontSize: 19, theme: 'light' },
        backupRecoveryMarker: recoveryMarker
      })
    )
    let firstApp: ElectronApplication | null = null
    let restoredApp: ElectronApplication | null = null
    try {
      const first = await session.launch()
      firstApp = first.app
      await waitForSessionReady(first.page)
      expect(
        await first.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible())
        )
      ).toBe(true)
      await first.page.evaluate(async () => {
        const update = window.__store?.getState().updateSettingsOrThrow
        if (!update) {
          throw new Error('Renderer settings persistence is unavailable')
        }
        await update({ theme: 'dark' })
      })

      // Only normal app writes create this recovery point; the test never calls a snapshot writer.
      await expect
        .poll(() => profileStateDatabaseBackups(databasePath).length, { timeout: 30_000 })
        .toBeGreaterThan(0)
      const backup = profileStateDatabaseBackups(databasePath)[0]
      const chosen = readSnapshot(backup.path)
      expect(JSON.parse(chosen.json)).toMatchObject({
        settings: { terminalFontSize: 19 },
        backupRecoveryMarker: recoveryMarker
      })
      if (recoveryRuntime === 'electron') {
        expect(statSync(backup.path).size).toBeGreaterThan(8 * 1024 * 1024)
      }
      const backupBytes = readFileSync(backup.path)
      await first.page.evaluate(async () => {
        const update = window.__store?.getState().updateSettingsOrThrow
        if (!update) {
          throw new Error('Renderer settings persistence is unavailable')
        }
        await update({ terminalFontSize: 23 })
      })
      await expect
        .poll(() => JSON.parse(readSnapshot(databasePath).json).settings.terminalFontSize)
        .toBe(23)
      expect(readFileSync(backup.path).equals(backupBytes)).toBe(true)
      const beforeRefusal = readSnapshot(databasePath)
      const recoveryExecutable =
        recoveryRuntime === 'electron'
          ? await first.app.evaluate(() => process.execPath)
          : undefined
      const refused = await rollbackProfileBackup(
        session.userDataDir,
        backup.id,
        recoveryExecutable
      )
      expect(refused.code).toBe(1)
      expect(refused.stdout + refused.stderr).toContain(
        recoveryRuntime === 'electron' ? 'Stop Orca' : 'in use'
      )
      expect(readSnapshot(databasePath)).toEqual(beforeRefusal)
      expect(readFileSync(backup.path).equals(backupBytes)).toBe(true)
      await session.close(firstApp)
      firstApp = null
      await cleanupE2EDaemons(session.userDataDir)

      for (const file of [dataFile, rootJson, `${databasePath}-wal`, `${databasePath}-shm`]) {
        rmSync(file, { force: true })
      }
      // Preserve both large artifacts so quarantine exercises batched recovery copies.
      const corruptPrimary = readFileSync(databasePath)
      corruptPrimary.write('deliberately corrupt SQLite primary')
      writeFileSync(databasePath, corruptPrimary)
      if (recoveryRuntime === 'electron') {
        expect(corruptPrimary.length).toBeGreaterThan(8 * 1024 * 1024)
      }
      expect(() => readSnapshot(databasePath)).toThrow()
      const restored = await rollbackProfileBackup(
        session.userDataDir,
        backup.id,
        recoveryExecutable
      )
      expect(restored.code, restored.stderr || restored.stdout).toBe(0)
      const recovered = JSON.parse(restored.stdout)
      expect(recovered).toMatchObject({
        ok: true,
        result: {
          storage: 'sqlite',
          backupId: backup.id,
          revision: chosen.revision,
          profileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
          restoredPath: recoveryRuntime === 'electron' ? realpathSync(databasePath) : databasePath
        }
      })
      expect(readSnapshot(databasePath)).toEqual(chosen)
      const quarantineDirectory: unknown = recovered.result.quarantineDirectory
      if (typeof quarantineDirectory !== 'string') {
        throw new Error('Recovery did not report its quarantine directory')
      }
      expect(
        readFileSync(path.join(quarantineDirectory, 'profile-state.db')).equals(corruptPrimary)
      ).toBe(true)
      expect(
        readFileSync(path.join(quarantineDirectory, path.basename(backup.path))).equals(backupBytes)
      ).toBe(true)
      expect(readFileSync(backup.path).equals(backupBytes)).toBe(true)
      expect(existsSync(dataFile)).toBe(false)

      const relaunched = await session.launch()
      restoredApp = relaunched.app
      await waitForSessionReady(relaunched.page)
      await expect
        .poll(() =>
          relaunched.page.evaluate(() => window.__store?.getState().settings?.terminalFontSize)
        )
        .toBe(19)
      await expect(relaunched.page.locator('html')).toHaveClass(
        JSON.parse(chosen.json).settings.theme === 'dark' ? /\bdark\b/ : /\blight\b/
      )
      expect(JSON.parse(readSnapshot(databasePath).json).backupRecoveryMarker).toEqual(
        recoveryMarker
      )
      expect(
        await relaunched.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible())
        )
      ).toBe(true)
      expect(existsSync(dataFile)).toBe(false)
    } finally {
      try {
        if (restoredApp) {
          await session.close(restoredApp)
        }
        if (firstApp) {
          await session.close(firstApp)
        }
      } finally {
        await session.dispose()
      }
    }
  })
}
