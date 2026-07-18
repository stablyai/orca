import { existsSync, readFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  forceKillElectronApp,
  forceKillProcessTree,
  readDaemonPid,
  readPersistedData,
  writePersistedData
} from './helpers/force-exit-session'

const PROVIDER_SESSION_ID = 'e2e-completed-force-exit-session'

async function createTerminalTab(page: Page): Promise<string> {
  const activeBefore = await getActiveTabId(page)
  const tabId = await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Active worktree unavailable while creating the second terminal')
    }
    // Why: this restart proof targets pane ownership, so store creation avoids
    // coupling it to tab-menu hit testing and viewport layout.
    return state.createTab(state.activeWorktreeId).id
  })
  await expect
    .poll(async () => (await getActiveTabId(page)) === tabId && tabId !== activeBefore, {
      timeout: 10_000,
      message: 'New terminal did not become active'
    })
    .toBe(true)
  return tabId
}

function persistedCompletedRecordExists(
  userDataDir: string,
  paneKey: string,
  tabId: string
): boolean {
  const record =
    readPersistedData(userDataDir).workspaceSession?.sleepingAgentSessionsByPaneKey?.[paneKey]
  return (
    record?.paneKey === paneKey &&
    record.tabId === tabId &&
    record.state === 'done' &&
    record.origin === 'completed' &&
    record.providerSession?.id === PROVIDER_SESSION_ID
  )
}

function makePersistedResumeHermetic(userDataDir: string, paneKey: string): void {
  const data = readPersistedData(userDataDir)
  const record = data.workspaceSession?.sleepingAgentSessionsByPaneKey?.[paneKey]
  if (!record || record.providerSession?.id !== PROVIDER_SESSION_ID) {
    throw new Error(`Completed recovery record ${paneKey} was not persisted`)
  }
  // Why: prove Orca builds and runs the resume command without requiring a
  // developer or CI machine to have the real Codex binary installed.
  record.launchConfig = { agentCommand: 'echo', agentArgs: '', agentEnv: {} }
  writePersistedData(userDataDir, data)
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable while activating completed conversation tab')
    }
    state.setActiveTabType('terminal')
    state.setActiveTab(targetTabId)
  }, tabId)
  await expect.poll(() => getActiveTabId(page), { timeout: 10_000 }).toBe(tabId)
}

test.describe.configure({ mode: 'serial' })

test('completed conversation resumes in its original pane after force-exit restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires object destructuring to opt out of default fixtures.
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
        timeout: 30_000
      })
      .toBe(true)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)

    const original = await waitForActivePaneHookDescriptor(page)
    const originalTabId = await getActiveTabId(page)
    if (!originalTabId) {
      throw new Error('Original completed-conversation tab id was unavailable')
    }

    await page.evaluate(
      ({ paneKey, worktreeId: wtId, providerSessionId }) => {
        const state = window.__store?.getState()
        state?.setAgentStatus(
          paneKey,
          { state: 'working', prompt: 'finish the task', agentType: 'codex' },
          'Codex',
          undefined,
          { tabId: paneKey.split(':')[0], worktreeId: wtId },
          { providerSession: { key: 'session_id', id: providerSessionId } }
        )
        state?.setAgentStatus(
          paneKey,
          { state: 'done', prompt: 'finish the task', agentType: 'codex' },
          'Codex',
          undefined,
          { tabId: paneKey.split(':')[0], worktreeId: wtId },
          { providerSession: { key: 'session_id', id: providerSessionId } }
        )
      },
      {
        paneKey: original.paneKey,
        worktreeId: original.worktreeId,
        providerSessionId: PROVIDER_SESSION_ID
      }
    )

    await expect
      .poll(
        () =>
          page.evaluate(
            (paneKey) => window.__store?.getState().sleepingAgentSessionsByPaneKey[paneKey],
            original.paneKey
          ),
        { timeout: 10_000 }
      )
      .toMatchObject({
        paneKey: original.paneKey,
        tabId: originalTabId,
        state: 'done',
        origin: 'completed',
        providerSession: { id: PROVIDER_SESSION_ID }
      })

    await createTerminalTab(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForActivePanePtyId(page, 30_000)

    await expect
      .poll(
        () => persistedCompletedRecordExists(session.userDataDir, original.paneKey, originalTabId),
        {
          timeout: 30_000,
          message: 'Completed recovery identity did not reach disk before force exit'
        }
      )
      .toBe(true)

    const daemonPid = readDaemonPid(session.userDataDir)
    await forceKillElectronApp(firstApp)
    firstApp = null
    await forceKillProcessTree(daemonPid)
    makePersistedResumeHermetic(session.userDataDir, original.paneKey)

    const secondLaunch = await session.launch()
    secondApp = secondLaunch.app
    const restartedPage = secondLaunch.page
    await waitForSessionReady(restartedPage)
    await expect
      .poll(() => restartedPage.evaluate(() => window.__store?.getState().activeWorktreeId), {
        timeout: 15_000
      })
      .toBe(worktreeId)
    await ensureTerminalVisible(restartedPage)
    await waitForActiveTerminalManager(restartedPage, 30_000)

    await expect
      .poll(
        () =>
          restartedPage.evaluate(
            ({ wtId, paneKey }) => {
              const state = window.__store?.getState()
              return {
                tabCount: (state?.tabsByWorktree[wtId] ?? []).length,
                recovery: state?.sleepingAgentSessionsByPaneKey[paneKey]
              }
            },
            { wtId: worktreeId, paneKey: original.paneKey }
          ),
        { timeout: 15_000 }
      )
      .toMatchObject({
        tabCount: 2,
        recovery: { origin: 'completed', state: 'done' }
      })

    await activateTerminalTab(restartedPage, originalTabId)
    await waitForActiveTerminalManager(restartedPage, 30_000)
    await waitForTerminalOutput(restartedPage, PROVIDER_SESSION_ID, 30_000)

    const resumed = await waitForActivePaneHookDescriptor(restartedPage)
    expect(resumed.paneKey).toBe(original.paneKey)
    // Why: the hermetic echo command emits no fresh agent hook, so the main
    // hook cache restores the completed checkpoint after cold-restore consumes it.
    await expect
      .poll(
        () =>
          restartedPage.evaluate(
            ({ wtId, paneKey }) => {
              const state = window.__store?.getState()
              return {
                tabCount: (state?.tabsByWorktree[wtId] ?? []).length,
                recovery: state?.sleepingAgentSessionsByPaneKey[paneKey]
              }
            },
            { wtId: worktreeId, paneKey: original.paneKey }
          ),
        { timeout: 15_000 }
      )
      .toMatchObject({
        tabCount: 2,
        recovery: {
          paneKey: original.paneKey,
          origin: 'completed',
          providerSession: { id: PROVIDER_SESSION_ID }
        }
      })
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
