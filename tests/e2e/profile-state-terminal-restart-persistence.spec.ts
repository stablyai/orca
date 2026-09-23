/** Candidate SQLite terminal restart/profile journeys. */

import { readFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { getRepoIdFromWorktreeId } from '../../src/shared/worktree/id'
import { test, expect } from './helpers/orca-app'
import { forceQuitElectronAppForE2E } from './helpers/electron-process-shutdown'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { execInTerminal, waitForTerminalOutput, waitForActivePanePtyId } from './helpers/terminal'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getWorktreeTabs
} from './helpers/store'
import {
  seededRepoPathOrSkip,
  bootstrapFirstLaunch,
  bootstrapRestoredLaunch,
  waitForElectronProcessExit
} from './helpers/terminal-restart-persistence'

test.describe.configure({ mode: 'serial' })

test.describe('SQLite candidate terminal restart persistence', () => {
  test('SQLite survives restart after legacy JSON is removed', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = seededRepoPathOrSkip()

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId, ptyId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)

      const automationName = `sqlite-candidate-restart-${Date.now()}`
      const automationPrompt = 'Persist this candidate automation across an SQLite-only restart.'
      const automationLifecycle = await firstLaunch.page.evaluate(
        async ({ name, prompt }) => {
          const isRecord = (value: unknown): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null && !Array.isArray(value)
          const repo = window.__store?.getState().repos[0]
          if (!repo) {
            throw new Error('SQLite candidate E2E did not find a seeded repository')
          }
          const response = await window.api.runtime.call({
            method: 'automation.create',
            params: {
              agentId: 'codex',
              name,
              prompt,
              repo: `id:${repo.id}`,
              // Keep a full run context in the persisted definition so `runNow`
              // exercises the same runtime RPC and normalized automationRuns
              // path used by real scheduled work.
              runContext: {
                kind: 'workspace-run',
                projectId: repo.id,
                hostId: 'runtime:missing',
                projectHostSetupId: `missing-${Date.now()}`,
                repoId: repo.id,
                path: repo.path
              },
              workspaceMode: 'new_per_run',
              reuseSession: false,
              timezone: 'UTC',
              rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
              dtstart: Date.now(),
              enabled: false,
              missedRunGraceMinutes: 720
            }
          })
          if (!response.ok) {
            throw new Error(`${response.error.code}: ${response.error.message}`)
          }
          const createResult = isRecord(response.result) ? response.result : null
          const automation =
            createResult && isRecord(createResult.automation) ? createResult.automation : null
          if (!automation || typeof automation.id !== 'string') {
            throw new Error('automation.create returned an invalid automation')
          }
          const runResponse = await window.api.runtime.call({
            method: 'automation.runNow',
            params: { id: automation.id }
          })
          if (!runResponse.ok) {
            throw new Error(`${runResponse.error.code}: ${runResponse.error.message}`)
          }
          const runResult = isRecord(runResponse.result) ? runResponse.result : null
          const run = runResult && isRecord(runResult.run) ? runResult.run : null
          if (!run || typeof run.id !== 'string' || typeof run.status !== 'string') {
            throw new Error('automation.runNow returned an invalid run')
          }
          return {
            automationId: automation.id,
            runId: run.id,
            runStatus: run.status
          }
        },
        { name: automationName, prompt: automationPrompt }
      )
      expect(automationLifecycle.runStatus).toBe('dispatching')

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
        throw new Error('SQLite cutover E2E did not find an active profile id')
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
      expect(existsSync(legacyProfileState)).toBe(true)

      // Prove the next launch has only the SQLite authority available.
      rmSync(legacyProfileState, { force: true })
      rmSync(legacyRootState, { force: true })
      expect(existsSync(legacyProfileState)).toBe(false)
      expect(existsSync(legacyRootState)).toBe(false)

      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)
      expect(existsSync(legacyProfileState)).toBe(false)
      expect(existsSync(legacyRootState)).toBe(false)
      // The daemon survives the clean Electron restart, so a SQLite-only launch
      // must reattach the same PTY binding instead of silently spawning a new shell.
      await expect
        .poll(() => waitForActivePanePtyId(secondLaunch.page), { timeout: 15_000 })
        .toBe(ptyId)
      const ptyMarker = `SQLITE_PTY_REATTACHED_${Date.now()}`
      await execInTerminal(secondLaunch.page, ptyId, `echo ${ptyMarker}`)
      await waitForTerminalOutput(secondLaunch.page, ptyMarker)
      await expect
        .poll(
          async () =>
            await secondLaunch.page.evaluate(
              async ({ name, prompt }) => {
                const response = await window.api.runtime.call({ method: 'automation.list' })
                if (!response.ok) {
                  return false
                }
                if (
                  typeof response.result !== 'object' ||
                  response.result === null ||
                  !('automations' in response.result) ||
                  !Array.isArray(response.result.automations)
                ) {
                  return false
                }
                return response.result.automations.some((automation) => {
                  if (typeof automation !== 'object' || automation === null) {
                    return false
                  }
                  return (
                    'name' in automation &&
                    'prompt' in automation &&
                    automation.name === name &&
                    automation.prompt === prompt
                  )
                })
              },
              { name: automationName, prompt: automationPrompt }
            ),
          { timeout: 10_000 }
        )
        .toBe(true)
      await expect
        .poll(
          async () =>
            await secondLaunch.page.evaluate(async ({ automationId, runId }) => {
              const response = await window.api.runtime.call({
                method: 'automation.runs',
                params: { automationId }
              })
              if (
                !response.ok ||
                typeof response.result !== 'object' ||
                response.result === null ||
                !('runs' in response.result) ||
                !Array.isArray(response.result.runs)
              ) {
                return false
              }
              return response.result.runs.some(
                (run) => typeof run === 'object' && run !== null && 'id' in run && run.id === runId
              )
            }, automationLifecycle),
          { timeout: 10_000 }
        )
        .toBe(true)
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
    }
  })

  test('SQLite profile switch keeps independent profiles isolated', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = seededRepoPathOrSkip()

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null
    let thirdApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const defaultWorktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
      await waitForSessionReady(firstLaunch.page)
      const defaultProfileId = await firstLaunch.page.evaluate(async () => {
        const profiles = await window.api.orcaProfiles.list()
        return profiles.activeProfileId
      })
      const targetProfileId = await firstLaunch.page.evaluate(async () => {
        const created = await window.api.orcaProfiles.createLocal({
          name: `SQLite switch target ${Date.now()}`
        })
        return created.profile.id
      })

      const defaultProfileDirectory = path.join(session.userDataDir, 'profiles', defaultProfileId)
      const defaultJson = path.join(defaultProfileDirectory, 'orca-data.json')
      const rootJson = path.join(session.userDataDir, 'orca-data.json')
      const defaultDatabase = path.join(defaultProfileDirectory, 'profile-state.db')
      expect(existsSync(defaultDatabase)).toBe(true)

      // The target switch must flush and publish the index before relaunching.
      await expect(
        firstLaunch.page.evaluate(
          (profileId) => window.api.orcaProfiles.switchProfile({ profileId }),
          targetProfileId
        )
      ).resolves.toEqual({ status: 'relaunching' })
      await waitForElectronProcessExit(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page)
      const targetList = await secondLaunch.page.evaluate(() => window.api.orcaProfiles.list())
      expect(targetList.activeProfileId).toBe(targetProfileId)
      const targetProfileDirectory = path.join(session.userDataDir, 'profiles', targetProfileId)
      const targetDatabase = path.join(targetProfileDirectory, 'profile-state.db')
      const targetJson = path.join(targetProfileDirectory, 'orca-data.json')
      expect(existsSync(targetDatabase)).toBe(true)

      // Seed an independent target-profile document before removing its JSON mirror.
      await attachRepoAndOpenTerminal(secondLaunch.page, repoPath)
      await waitForSessionReady(secondLaunch.page)
      rmSync(targetJson, { force: true })
      rmSync(defaultJson, { force: true })
      rmSync(rootJson, { force: true })
      expect(existsSync(targetJson)).toBe(false)
      expect(existsSync(defaultJson)).toBe(false)
      expect(existsSync(rootJson)).toBe(false)

      await expect(
        secondLaunch.page.evaluate(
          (profileId) => window.api.orcaProfiles.switchProfile({ profileId }),
          defaultProfileId
        )
      ).resolves.toEqual({ status: 'relaunching' })
      await waitForElectronProcessExit(secondApp)
      secondApp = null

      const thirdLaunch = await session.launch()
      thirdApp = thirdLaunch.app
      await waitForSessionReady(thirdLaunch.page)
      const finalList = await thirdLaunch.page.evaluate(() => window.api.orcaProfiles.list())
      expect(finalList.activeProfileId).toBe(defaultProfileId)
      expect(existsSync(defaultDatabase)).toBe(true)
      expect(existsSync(targetDatabase)).toBe(true)
      expect(existsSync(defaultJson)).toBe(false)
      expect(existsSync(targetJson)).toBe(false)
      await waitForActiveWorktree(thirdLaunch.page)
      await expect
        .poll(() => getActiveWorktreeId(thirdLaunch.page), { timeout: 10_000 })
        .toBe(defaultWorktreeId)
    } finally {
      if (thirdApp) {
        await session.close(thirdApp)
      }
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
    }
  })

  test('SQLite moves a project across JSON-free profiles', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = seededRepoPathOrSkip()

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null
    let thirdApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const worktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
      await waitForSessionReady(firstLaunch.page)
      const profileState = await firstLaunch.page.evaluate(async (repoId) => {
        const profiles = await window.api.orcaProfiles.list()
        const repo = window.__store?.getState().repos.find((entry) => entry.id === repoId)
        if (!repo) {
          throw new Error('SQLite profile move E2E did not find the seeded repository')
        }
        const target = await window.api.orcaProfiles.createLocal({
          name: `SQLite move target ${Date.now()}`
        })
        return {
          sourceProfileId: profiles.activeProfileId,
          targetProfileId: target.profile.id,
          repoId: repo.id
        }
      }, getRepoIdFromWorktreeId(worktreeId))

      const sourceDirectory = path.join(
        session.userDataDir,
        'profiles',
        profileState.sourceProfileId
      )
      const targetDirectory = path.join(
        session.userDataDir,
        'profiles',
        profileState.targetProfileId
      )
      const sourceDatabase = path.join(sourceDirectory, 'profile-state.db')
      const targetDatabase = path.join(targetDirectory, 'profile-state.db')
      const sourceJson = path.join(sourceDirectory, 'orca-data.json')
      const targetJson = path.join(targetDirectory, 'orca-data.json')
      const rootJson = path.join(session.userDataDir, 'orca-data.json')
      expect(existsSync(sourceDatabase)).toBe(true)

      // Visit the target once so candidate startup establishes its own database before the move.
      await expect(
        firstLaunch.page.evaluate(
          (profileId) => window.api.orcaProfiles.switchProfile({ profileId }),
          profileState.targetProfileId
        )
      ).resolves.toEqual({ status: 'relaunching' })
      await waitForElectronProcessExit(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page)
      expect(await secondLaunch.page.evaluate(() => window.api.orcaProfiles.list())).toMatchObject({
        activeProfileId: profileState.targetProfileId
      })
      expect(existsSync(targetDatabase)).toBe(true)

      await expect(
        secondLaunch.page.evaluate(
          (profileId) => window.api.orcaProfiles.switchProfile({ profileId }),
          profileState.sourceProfileId
        )
      ).resolves.toEqual({ status: 'relaunching' })
      await waitForElectronProcessExit(secondApp)
      secondApp = null

      const thirdLaunch = await session.launch()
      thirdApp = thirdLaunch.app
      await waitForSessionReady(thirdLaunch.page)
      const moveResult = await thirdLaunch.page.evaluate(
        (args) => window.api.orcaProfiles.transferProject(args),
        {
          sourceProfileId: profileState.sourceProfileId,
          targetProfileId: profileState.targetProfileId,
          repoId: profileState.repoId,
          mode: 'move' as const
        }
      )
      expect(moveResult).toMatchObject({
        status: 'transferred',
        mode: 'move',
        willRelaunch: true
      })
      await waitForElectronProcessExit(thirdApp)
      thirdApp = null

      // The move commits both SQLite participants before relaunch. Remove every JSON mirror to
      // prove the target and source are both reopened from their databases alone.
      for (const legacyPath of [sourceJson, targetJson, rootJson]) {
        rmSync(legacyPath, { force: true })
      }
      expect(existsSync(sourceJson)).toBe(false)
      expect(existsSync(targetJson)).toBe(false)

      const targetLaunch = await session.launch()
      secondApp = targetLaunch.app
      await waitForSessionReady(targetLaunch.page)
      expect(await targetLaunch.page.evaluate(() => window.api.orcaProfiles.list())).toMatchObject({
        activeProfileId: profileState.targetProfileId
      })
      expect(
        await targetLaunch.page.evaluate(
          (repoId) => window.__store?.getState().repos.some((repo) => repo.id === repoId),
          profileState.repoId
        )
      ).toBe(true)
      expect(existsSync(targetDatabase)).toBe(true)

      await expect(
        targetLaunch.page.evaluate(
          (profileId) => window.api.orcaProfiles.switchProfile({ profileId }),
          profileState.sourceProfileId
        )
      ).resolves.toEqual({ status: 'relaunching' })
      await waitForElectronProcessExit(secondApp)
      secondApp = null

      const sourceLaunch = await session.launch()
      thirdApp = sourceLaunch.app
      await waitForSessionReady(sourceLaunch.page)
      expect(await sourceLaunch.page.evaluate(() => window.api.orcaProfiles.list())).toMatchObject({
        activeProfileId: profileState.sourceProfileId
      })
      expect(
        await sourceLaunch.page.evaluate(
          (repoId) => window.__store?.getState().repos.some((repo) => repo.id === repoId),
          profileState.repoId
        )
      ).toBe(false)
      expect(existsSync(sourceDatabase)).toBe(true)
      expect(existsSync(sourceJson)).toBe(false)
      expect(existsSync(targetJson)).toBe(false)
    } finally {
      if (thirdApp) {
        await session.close(thirdApp)
      }
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
    }
  })

  test('SQLite survives abrupt process termination after legacy JSON is removed', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = seededRepoPathOrSkip()

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
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

      // Remove both JSON mirrors before the kill. Any state recovered by the next
      // launch must therefore come from SQLite, including the terminal topology.
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

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)
      expect(existsSync(legacyProfileState)).toBe(false)
      expect(existsSync(legacyRootState)).toBe(false)
      // The daemon survives the Electron crash, so a SQLite-only restart must
      // reattach the same PTY binding instead of silently spawning a new shell.
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
    }
  })
})
