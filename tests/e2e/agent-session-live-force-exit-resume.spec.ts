import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  execInTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { forceKillElectronAppForE2E } from './helpers/electron-process-shutdown'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'

const PROVIDER_SESSION_ID = 'e2e-live-force-exit-session'

type PersistedWorkspaceSession = {
  tabsByWorktree?: Record<string, { id?: unknown; ptyId?: unknown }[]>
  terminalLayoutsByTabId?: Record<string, unknown>
  activeWorktreeIdsOnShutdown?: unknown
  sleepingAgentSessionsByPaneKey?: Record<
    string,
    {
      providerSession?: { id?: unknown }
      launchConfig?: {
        agentCommand?: string
        agentArgs?: string
        agentEnv?: Record<string, string>
      }
    }
  >
}

type PersistedData = {
  workspaceSession?: PersistedWorkspaceSession
  settings?: {
    agentCmdOverrides?: Record<string, unknown>
  }
}

function dataFilePath(userDataDir: string): string {
  // Fresh sessions migrate the seeded legacy file, then persist only here.
  return path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
}

function readPersistedData(userDataDir: string): PersistedData {
  return JSON.parse(readFileSync(dataFilePath(userDataDir), 'utf8')) as PersistedData
}

function writePersistedData(userDataDir: string, data: PersistedData): void {
  writeFileSync(dataFilePath(userDataDir), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function daemonPidPath(userDataDir: string): string {
  return path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`)
}

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(daemonPidPath(userDataDir), 'utf8')
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return parsed.pid
}

function killPid(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

function stripPersistedPtyOwnership(userDataDir: string): void {
  const data = readPersistedData(userDataDir)
  const session = data.workspaceSession
  if (!session) {
    throw new Error('Expected persisted workspace session')
  }
  for (const tabs of Object.values(session.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      tab.ptyId = null
    }
  }
  // Why: this models the updater/crash artifact from #6370: the UI tab and
  // live resume record survive, but no pane has the old stable leaf key or
  // daemon session to own resume.
  session.terminalLayoutsByTabId = {}
  session.activeWorktreeIdsOnShutdown = []
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    if (record.providerSession?.id === PROVIDER_SESSION_ID) {
      // Why: the e2e proof should verify Orca launches the resumed command,
      // not depend on a developer machine having a real Codex CLI installed.
      record.launchConfig = { agentCommand: 'echo', agentArgs: '', agentEnv: {} }
    }
  }
  writePersistedData(userDataDir, data)
}

function persistedLiveRecordExists(userDataDir: string): boolean {
  const records = readPersistedData(userDataDir).workspaceSession?.sleepingAgentSessionsByPaneKey
  return Object.values(records ?? {}).some(
    (record) => record.providerSession?.id === PROVIDER_SESSION_ID
  )
}

function findHookStatusPath(userDataDir: string): string | null {
  const visit = (directory: string): string | null => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isFile() && entry.name === 'last-status.json') {
        return fullPath
      }
      if (entry.isDirectory()) {
        const nested = visit(fullPath)
        if (nested) {
          return nested
        }
      }
    }
    return null
  }
  const roots = [
    path.join(userDataDir, 'agent-hooks'),
    path.join(path.dirname(dataFilePath(userDataDir)), 'agent-hooks')
  ]
  for (const root of roots) {
    if (!existsSync(root)) {
      continue
    }
    const statusPath = visit(root)
    if (statusPath) {
      return statusPath
    }
  }
  return null
}

function persistedHookLiveRecordExists(userDataDir: string): boolean {
  const statusPath = findHookStatusPath(userDataDir)
  if (!statusPath) {
    return false
  }
  const data = JSON.parse(readFileSync(statusPath, 'utf8')) as {
    entries?: Record<string, { providerSession?: { id?: unknown }; payload?: { state?: unknown } }>
  }
  return Object.values(data.entries ?? {}).some(
    (entry) =>
      entry.providerSession?.id === PROVIDER_SESSION_ID && entry.payload?.state === 'working'
  )
}

function removePersistedLiveRecord(userDataDir: string): void {
  const data = readPersistedData(userDataDir)
  const records = data.workspaceSession?.sleepingAgentSessionsByPaneKey
  if (!records) {
    return
  }
  for (const [paneKey, record] of Object.entries(records)) {
    if (record.providerSession?.id === PROVIDER_SESSION_ID) {
      delete records[paneKey]
    }
  }
  writePersistedData(userDataDir, data)
}

function persistedCodexEchoOverrideExists(userDataDir: string): boolean {
  return readPersistedData(userDataDir).settings?.agentCmdOverrides?.codex === 'echo'
}

test.describe.configure({ mode: 'serial' })

test('resumes a live agent record after force-exit restart when pane PTY ownership is gone', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const page = firstLaunch.page
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    // Why: the session writer persists only once hydrationSucceeded flips (not
    // just workspaceSessionReady) — see shouldPersistWorkspaceSession — so the
    // record write below is a silent no-op until hydration completes.
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().hydrationSucceeded === true), {
        timeout: 30_000,
        message: 'hydrationSucceeded did not become true before persisting the live record'
      })
      .toBe(true)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(page)
    const ptyId = await waitForActivePanePtyId(page)
    const transcriptPath = session.seedCodexResumeRollout(PROVIDER_SESSION_ID, repoPath)
    const marker = `AGENT_LIVE_FORCE_EXIT_${Date.now()}`
    await execInTerminal(page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(page, marker)

    await page.evaluate(
      ({ paneKey, worktreeId: wtId, providerSessionId, transcriptPath }) => {
        window.__store?.getState().setAgentStatus(
          paneKey,
          { state: 'working', prompt: 'finish the task', agentType: 'codex' },
          'Codex',
          undefined,
          { worktreeId: wtId },
          {
            providerSession: {
              key: 'session_id',
              id: providerSessionId,
              transcriptPath
            }
          }
        )
      },
      {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        providerSessionId: PROVIDER_SESSION_ID,
        transcriptPath
      }
    )

    // Exercise quit capture: origin:'quit' changes the live record, triggering the
    // hydration-gated writer before polling persisted state.
    await page.evaluate(() => window.__store?.getState().captureAllSleepingAgentSessions('quit'))

    // Why: the record reaches disk via the debounced session writer (150ms) plus
    // the main-process scheduleSave (up to 5s). Under CI event-loop starvation —
    // the same shard drifts renderer timers ~1s — both stages need headroom, so
    // poll to 30s (this suite's other readiness budget). On a miss, surface store
    // vs disk state to separate a lost write from a merely slow flush.
    const persistDeadline = Date.now() + 30_000
    let persisted = false
    while (Date.now() < persistDeadline) {
      if (persistedLiveRecordExists(session.userDataDir)) {
        persisted = true
        break
      }
      await page.waitForTimeout(250)
    }
    if (!persisted) {
      const storeRecords = await page.evaluate(
        () => window.__store?.getState().sleepingAgentSessionsByPaneKey
      )
      throw new Error(
        `Live sleeping-agent record was not persisted before force exit. store=${JSON.stringify(
          storeRecords
        )} disk=${JSON.stringify(
          readPersistedData(session.userDataDir).workspaceSession?.sleepingAgentSessionsByPaneKey
        )}`
      )
    }

    const daemonPid = readDaemonPid(session.userDataDir)
    await forceKillElectronAppForE2E(firstApp)
    firstApp = null
    killPid(daemonPid)
    stripPersistedPtyOwnership(session.userDataDir)

    const secondLaunch = await session.launch()
    secondApp = secondLaunch.app
    await waitForSessionReady(secondLaunch.page)
    await expect
      .poll(
        async () => secondLaunch.page.evaluate(() => window.__store?.getState().activeWorktreeId),
        { timeout: 15_000 }
      )
      .toBe(worktreeId)
    await ensureTerminalVisible(secondLaunch.page)
    await waitForActiveTerminalManager(secondLaunch.page, 30_000)

    await waitForTerminalOutput(secondLaunch.page, PROVIDER_SESSION_ID, 30_000)

    const terminalTabCount = await secondLaunch.page.evaluate(
      (wtId) => (window.__store?.getState().tabsByWorktree[wtId] ?? []).length,
      worktreeId
    )
    // Cold restore reuses the rebuilt tab. It must not create a duplicate tab
    // or auto-submit the old prompt as a second agent launch.
    expect(terminalTabCount).toBe(1)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await forceKillElectronAppForE2E(firstApp)
    }
    await session.dispose()
  }
})

test('reconstructs a live session from the main hook cache after renderer force-exit', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const page = firstLaunch.page
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().hydrationSucceeded === true), {
        timeout: 30_000,
        message: 'hydrationSucceeded did not become true before hook-cache recovery test'
      })
      .toBe(true)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(page)
    const endpoint = await readHookEndpoint(firstApp)
    const transcriptPath = session.seedCodexResumeRollout(PROVIDER_SESSION_ID, repoPath)
    // The command override makes the cold-restore assertion hermetic while
    // leaving the provider session itself sourced from the main hook cache.
    await page.evaluate(() =>
      window.__store?.getState().updateSettings({ agentCmdOverrides: { codex: 'echo' } })
    )
    await expect
      .poll(() => persistedCodexEchoOverrideExists(session.userDataDir), {
        timeout: 30_000,
        message: 'The hermetic Codex command override was not flushed before force exit'
      })
      .toBe(true)
    await emitCodexHookStatus(endpoint, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      state: 'working',
      prompt: 'recover from the main hook cache',
      providerSessionId: PROVIDER_SESSION_ID,
      transcriptPath
    })

    await expect
      .poll(() => persistedHookLiveRecordExists(session.userDataDir), {
        timeout: 10_000,
        message: 'Main hook cache did not synchronously persist the live provider session'
      })
      .toBe(true)

    // Kill the renderer before removing its persisted record. Otherwise a
    // debounced renderer session write can race the test's file edit and
    // resurrect the record we are deliberately removing.
    const daemonPid = readDaemonPid(session.userDataDir)
    await forceKillElectronAppForE2E(firstApp)
    firstApp = null
    killPid(daemonPid)
    // The only remaining recovery authority is last-status.json in the
    // main-side hook cache, which is the crash path this test proves.
    removePersistedLiveRecord(session.userDataDir)
    stripPersistedPtyOwnership(session.userDataDir)
    expect(persistedLiveRecordExists(session.userDataDir)).toBe(false)

    const secondLaunch = await session.launch()
    secondApp = secondLaunch.app
    await waitForSessionReady(secondLaunch.page)
    await expect
      .poll(
        async () => secondLaunch.page.evaluate(() => window.__store?.getState().activeWorktreeId),
        { timeout: 15_000 }
      )
      .toBe(worktreeId)
    await ensureTerminalVisible(secondLaunch.page)
    await waitForActiveTerminalManager(secondLaunch.page, 30_000)

    await waitForTerminalOutput(secondLaunch.page, PROVIDER_SESSION_ID, 30_000)

    // Hook-cache recovery must reuse the rebuilt tab, not fork a duplicate.
    const terminalTabCount = await secondLaunch.page.evaluate(
      (wtId) => (window.__store?.getState().tabsByWorktree[wtId] ?? []).length,
      worktreeId
    )
    expect(terminalTabCount).toBe(1)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await forceKillElectronAppForE2E(firstApp)
    }
    await session.dispose()
  }
})
