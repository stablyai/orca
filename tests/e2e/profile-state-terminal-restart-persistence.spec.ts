import { readFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'

import { test, expect } from './helpers/orca-app'
import { forceQuitElectronAppForE2E } from './helpers/electron-process-shutdown'
import { createRestartSession } from './helpers/orca-restart'
import { execInTerminal, waitForTerminalOutput, waitForActivePanePtyId } from './helpers/terminal'
import { getWorktreeTabs } from './helpers/store'
import {
  seededRepoPathOrSkip,
  bootstrapFirstLaunch,
  bootstrapRestoredLaunch
} from './helpers/terminal-restart-persistence'

test.describe.configure({ mode: 'serial' })

test.describe('SQLite candidate terminal restart persistence', () => {
  test('SQLite survives abrupt process termination after legacy JSON is removed', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = seededRepoPathOrSkip()

    const session = createRestartSession(testInfo)
    const stderr: string[] = []
    const launchOptions = {
      onStderr: (chunk: string): void => {
        stderr.push(chunk)
      }
    }
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch(launchOptions)
      firstApp = firstLaunch.app
      const { worktreeId, ptyId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)

      const profileIndex: unknown = JSON.parse(
        readFileSync(path.join(session.userDataDir, 'orca-profile-index.json'), 'utf8')
      )
      if (
        typeof profileIndex !== 'object' ||
        profileIndex === null ||
        Array.isArray(profileIndex) ||
        !('activeProfileId' in profileIndex) ||
        typeof profileIndex.activeProfileId !== 'string'
      ) {
        throw new Error('SQLite crash E2E did not find an active profile id')
      }
      const profileDirectory = path.join(
        session.userDataDir,
        'profiles',
        profileIndex.activeProfileId
      )
      const legacyProfileState = path.join(profileDirectory, 'orca-data.json')
      const legacyRootState = path.join(session.userDataDir, 'orca-data.json')
      const databasePath = path.join(profileDirectory, 'profile-state.db')
      expect(existsSync(databasePath)).toBe(true)

      // Remove JSON before the kill so only SQLite can recover terminal topology.
      rmSync(legacyProfileState, { force: true })
      rmSync(legacyRootState, { force: true })
      expect(existsSync(legacyProfileState)).toBe(false)
      expect(existsSync(legacyRootState)).toBe(false)

      const mainPid = await firstApp.evaluate(() => process.pid)
      await forceQuitElectronAppForE2E(firstApp, { preserveDaemons: true })
      // Windows Playwright exposes a cmd wrapper; verify the actual Electron process exited.
      await expect
        .poll(() => {
          try {
            process.kill(mainPid, 0)
            return false
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
              return true
            }
            throw error
          }
        })
        .toBe(true)
      firstApp = null
      for (const suffix of ['', '-wal', '-shm']) {
        const filename = `profile-state.db${suffix}`
        const filePath = path.join(profileDirectory, filename)
        if (existsSync(filePath)) {
          await testInfo.attach(filename, {
            body: readFileSync(filePath),
            contentType: 'application/octet-stream'
          })
        }
      }

      const secondLaunch = await session.launch(launchOptions)
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)
      expect(existsSync(legacyProfileState)).toBe(false)
      expect(existsSync(legacyRootState)).toBe(false)
      // The daemon survives the crash; require the original PTY on SQLite-only restart.
      await expect
        .poll(() => waitForActivePanePtyId(secondLaunch.page), { timeout: 15_000 })
        .toBe(ptyId)
      const ptyMarker = `SQLITE_PTY_REATTACHED_AFTER_KILL_${Date.now()}`
      await execInTerminal(secondLaunch.page, ptyId, `echo ${ptyMarker}`)
      await waitForTerminalOutput(secondLaunch.page, ptyMarker)
      await expect
        .poll(async () => (await getWorktreeTabs(secondLaunch.page, worktreeId)).length, {
          timeout: 10_000
        })
        .toBeGreaterThanOrEqual(1)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
      await testInfo.attach('restart-stderr', {
        body: stderr.join(''),
        contentType: 'text/plain'
      })
    }
  })
})
