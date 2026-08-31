/**
 * A LOCAL agent that FINISHED its turn must not be respawned when the app
 * reopens the workspace.
 *
 * A completed turn is persisted with its state rewritten to 'working' and
 * origin 'live' (store/slices/agent-status.ts, `retainsResumableRecoveryIdentity`)
 * so an abrupt app death cold-restores into the agent instead of a bare shell
 * (#9454). Nothing downstream can then tell "finished" from "interrupted": once
 * the pane is gone, worktree activation reads the record as unfinished work and
 * opens a fresh tab running `--resume`. Killing the PTY removes the pane but
 * never the record, so `orca terminal stop`, a crash, or a pty-exit tab close
 * all leave one queued respawn per finished agent.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/finished-agent-ghost-resume.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
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
import { createHostRendererTerminalTab } from './helpers/host-created-terminal-retention-oracle'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'

const PROVIDER_SESSION_ID = 'e2e-finished-agent-session'

type PersistedRecord = {
  state?: unknown
  origin?: unknown
  providerSession?: { id?: unknown }
  launchConfig?: { agentCommand?: string; agentArgs?: string; agentEnv?: Record<string, string> }
}

function readPersistedRecords(userDataDir: string): Record<string, PersistedRecord> {
  const dataPath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as {
    workspaceSession?: { sleepingAgentSessionsByPaneKey?: Record<string, PersistedRecord> }
  }
  return data.workspaceSession?.sleepingAgentSessionsByPaneKey ?? {}
}

/** Make the resume hermetic: the respawned tab echoes instead of running codex. */
function stubPersistedResumeCommand(userDataDir: string): PersistedRecord {
  const dataPath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as {
    workspaceSession?: { sleepingAgentSessionsByPaneKey?: Record<string, PersistedRecord> }
  }
  const record = Object.values(data.workspaceSession?.sleepingAgentSessionsByPaneKey ?? {}).find(
    (candidate) => candidate.providerSession?.id === PROVIDER_SESSION_ID
  )
  if (!record) {
    throw new Error('Expected the finished agent turn to leave a persisted record')
  }
  record.launchConfig = { agentCommand: 'echo', agentArgs: '', agentEnv: {} }
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return record
}

test.describe.configure({ mode: 'serial' })

test('does not respawn an agent whose turn already finished', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
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
    const page = await firstApp.firstWindow()
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)

    const marker = `FINISHED_AGENT_${Date.now()}`
    const descriptor = await waitForActivePaneHookDescriptor(page)
    const ptyId = await waitForActivePanePtyId(page)
    const transcriptPath = session.seedCodexResumeRollout(PROVIDER_SESSION_ID, repoPath)
    await execInTerminal(page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(page, marker)

    // The agent reports its turn FINISHED — the ordinary end of an agent run.
    await page.evaluate(
      ({ paneKey, worktreeId: wtId, providerSessionId, transcriptPath }) => {
        window.__store
          ?.getState()
          .setAgentStatus(
            paneKey,
            { state: 'done', prompt: 'review the diff', agentType: 'codex' },
            'Codex',
            undefined,
            { worktreeId: wtId },
            { providerSession: { key: 'session_id', id: providerSessionId, transcriptPath } }
          )
      },
      {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        providerSessionId: PROVIDER_SESSION_ID,
        transcriptPath
      }
    )

    // The finished turn keeps its resume identity without restating done as work.
    const liveRecord = await page.evaluate((paneKey) => {
      const record = window.__store?.getState().sleepingAgentSessionsByPaneKey[paneKey]
      return record ? { state: record.state, origin: record.origin } : null
    }, descriptor.paneKey)
    expect(liveRecord, 'a finished turn leaves a resume record').not.toBeNull()
    expect(liveRecord?.state, 'the done turn stays done').toBe('done')
    expect(liveRecord?.origin).toBe('live')

    // A second, ordinary terminal: the reported workspaces were never empty, and
    // an empty one does not reactivate on relaunch at all.
    const survivingTabId = await createHostRendererTerminalTab(page, worktreeId)

    // The PTY dies and its tab closes with it — `orca terminal stop`, a crash,
    // or the pty-exit auto close. This reason deliberately keeps the record.
    const tabId = await page.evaluate(
      (wtId) => (window.__store?.getState().tabsByWorktree[wtId] ?? [])[0]?.id ?? null,
      worktreeId
    )
    expect(tabId, 'the agent pane must have a tab to close').not.toBeNull()
    expect(tabId).not.toBe(survivingTabId)
    await page.evaluate(
      (id) => window.__store?.getState().closeTab(id, { reason: 'pty-exit' }),
      tabId!
    )
    await expect
      .poll(
        async () =>
          page.evaluate(
            (wtId) => (window.__store?.getState().tabsByWorktree[wtId] ?? []).map((tab) => tab.id),
            worktreeId
          ),
        { timeout: 15_000, message: 'the pty-exit close never removed the agent tab' }
      )
      .toEqual([survivingTabId])

    await session.close(firstApp)
    firstApp = null

    // The record outlived the pane it belonged to.
    const persisted = readPersistedRecords(session.userDataDir)
    const survivor = Object.values(persisted).find(
      (candidate) => candidate.providerSession?.id === PROVIDER_SESSION_ID
    )
    expect(survivor, 'killing the pane left the resume record behind').toBeDefined()
    stubPersistedResumeCommand(session.userDataDir)

    // Reopening the workspace.
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

    // THE CLAIM: no tab was opened to resume an agent that had already finished.
    const respawned = await secondLaunch.page.evaluate((wtId) => {
      const state = window.__store?.getState()
      const tabs = state?.tabsByWorktree[wtId] ?? []
      return tabs.map((tab) => ({
        id: tab.id,
        launchAgent: tab.launchAgent ?? null,
        startup: state?.pendingStartupByTabId[tab.id]?.command ?? null,
        banner: state?.pendingStartupByTabId[tab.id]?.showSessionRestoredBanner ?? false
      }))
    }, worktreeId)
    const resumeTabs = respawned.filter(
      (tab) => tab.launchAgent === 'codex' || tab.startup?.includes(PROVIDER_SESSION_ID)
    )
    expect(resumeTabs, `a finished agent was respawned: ${JSON.stringify(respawned)}`).toEqual([])
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
