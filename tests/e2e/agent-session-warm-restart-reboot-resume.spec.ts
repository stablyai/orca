import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'

const PROVIDER_SESSION_ID = 'e2e-warm-then-reboot-session'

type PersistedWorkspaceSession = {
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

// Why: the e2e proof should verify Orca launches the resumed command, not
// depend on a developer machine having a real Codex CLI installed (mirrors
// agent-session-live-force-exit-resume.spec.ts's stripPersistedPtyOwnership).
function overrideResumeLaunchCommand(userDataDir: string, providerSessionId: string): void {
  const data = readPersistedData(userDataDir)
  const records = data.workspaceSession?.sleepingAgentSessionsByPaneKey
  if (!records) {
    throw new Error('Expected a persisted sleeping agent session record after quit')
  }
  let found = false
  for (const record of Object.values(records)) {
    if (record.providerSession?.id === providerSessionId) {
      record.launchConfig = { agentCommand: 'echo', agentArgs: '', agentEnv: {} }
      found = true
    }
  }
  if (!found) {
    throw new Error(
      `No persisted sleeping agent record found for provider session ${providerSessionId}`
    )
  }
  writePersistedData(userDataDir, data)
}

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return parsed.pid
}

test.describe.configure({ mode: 'serial' })

test('resumes an agent session after a warm restart followed by daemon death', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  let thirdApp: ElectronApplication | null = null

  try {
    // --- Run 1: create the pane, seed a live provider session, quit cleanly. ---
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const page = firstLaunch.page
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)

    const marker = `AGENT_WARM_REBOOT_${Date.now()}`
    const descriptor = await waitForActivePaneHookDescriptor(page)
    const firstPtyId = await waitForActivePanePtyId(page)
    await execInTerminal(page, firstPtyId, `echo ${marker}`)
    await waitForTerminalOutput(page, marker)

    // Why: a real agent run reports its provider session id over the hook
    // server; seeding the same store entry keeps this test hermetic (no agent
    // CLI install or auth) while exercising the identical persistence path.
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

    // Why: the daemon must survive the whole warm cycle below — read its pid
    // now, before either app quit, so run 3 kills the same process that owned
    // the PTY the warm-reattached pane in run 2 bound to.
    const daemonPid = readDaemonPid(session.userDataDir)

    await session.close(firstApp)
    firstApp = null

    // --- Run 2 (warm): daemon is still alive, app relaunches and reattaches
    // to the same PTY. No hook/status traffic must be emitted here — this
    // reproduces the pre-fix bug where the first title-derived status event
    // on a warm-reattached pane (no providerSession) deleted the persisted
    // sleeping-agent record. ---
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
    await waitForPaneCount(secondLaunch.page, 1, 30_000)

    // Confirm this was a true warm reattach (same daemon PTY), not a cold
    // restore of a fresh shell.
    const secondPtyId = await waitForActivePanePtyId(secondLaunch.page)
    expect(secondPtyId).toBe(firstPtyId)

    // NOTE: verifies the persisted record survives a close/reopen round-trip
    // with a live daemon; the title-event deletion path is separately guarded
    // by the 'adopts the persisted record session...' test in agent-status.test.ts.
    const recordId = await secondLaunch.page.evaluate(
      (paneKey) =>
        window.__store?.getState().sleepingAgentSessionsByPaneKey[paneKey]?.providerSession?.id,
      descriptor.paneKey
    )
    expect(recordId).toBe(PROVIDER_SESSION_ID)

    await session.close(secondApp)
    secondApp = null

    // --- Kill the daemon: simulates a reboot/crash/update kill while the app
    // is closed. SIGKILL leaves history checkpoints unclean so the relaunch
    // takes the cold-restore path. On Windows, Node maps SIGKILL to
    // TerminateProcess, giving the same abrupt "no clean shutdown" semantics
    // as POSIX SIGKILL. ---
    process.kill(daemonPid, 'SIGKILL')

    overrideResumeLaunchCommand(session.userDataDir, PROVIDER_SESSION_ID)

    // --- Run 3: cold restore. The provider session id captured in run 1 must
    // still drive a resume command into the freshly spawned pane. ---
    const thirdLaunch = await session.launch()
    thirdApp = thirdLaunch.app
    await waitForSessionReady(thirdLaunch.page)
    await expect
      .poll(
        async () => thirdLaunch.page.evaluate(() => window.__store?.getState().activeWorktreeId),
        { timeout: 15_000 }
      )
      .toBe(worktreeId)
    await ensureTerminalVisible(thirdLaunch.page)
    await waitForActiveTerminalManager(thirdLaunch.page, 30_000)
    await waitForPaneCount(thirdLaunch.page, 1, 30_000)

    await waitForTerminalOutput(thirdLaunch.page, PROVIDER_SESSION_ID, 30_000)

    // No duplicate resume tab: the run-1-origin record must not be consumed
    // twice across the warm reattach and the later cold restore.
    const terminalTabCount = await thirdLaunch.page.evaluate(
      (wtId) => (window.__store?.getState().tabsByWorktree[wtId] ?? []).length,
      worktreeId
    )
    expect(terminalTabCount).toBe(1)
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
