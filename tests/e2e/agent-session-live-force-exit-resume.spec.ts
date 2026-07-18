import { existsSync, readFileSync } from 'node:fs'
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
import {
  forceKillElectronApp,
  forceKillProcessTree,
  readDaemonPid,
  readPersistedData,
  writePersistedData
} from './helpers/force-exit-session'

const PROVIDER_SESSION_ID = 'e2e-live-force-exit-session'

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
    const marker = `AGENT_LIVE_FORCE_EXIT_${Date.now()}`
    await execInTerminal(page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(page, marker)

    await page.evaluate(
      ({ paneKey, worktreeId: wtId, providerSessionId }) => {
        window.__store
          ?.getState()
          .setAgentStatus(
            paneKey,
            { state: 'working', prompt: 'finish the task', agentType: 'codex' },
            'Codex',
            undefined,
            { worktreeId: wtId },
            { providerSession: { key: 'session_id', id: providerSessionId } }
          )
      },
      {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        providerSessionId: PROVIDER_SESSION_ID
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
    await forceKillElectronApp(firstApp)
    firstApp = null
    await forceKillProcessTree(daemonPid)
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
    expect(terminalTabCount).toBe(2)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await forceKillElectronApp(firstApp)
    }
    await session.dispose()
  }
})
