import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DaemonClient } from '../../src/main/daemon/client'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../src/main/daemon/daemon-spawner'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { FAKE_AGENT_WINDOWS_SHELL } from './helpers/fake-agent-command-override'
import {
  clearCompletedWorkerLedger,
  completedWorkerFakeCodexCommand,
  completedWorkerLaunchEnv,
  listRuntimeTerminals,
  readCompletedWorkerDispatchCapability,
  readCompletedWorkerLedger,
  seedCurrentCodexTranscript
} from './helpers/completed-worker-retirement-fixture'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalSummary } from '../../src/shared/runtime-types'
import { splitWorktreeIdForFilesystem } from '../../src/shared/worktree/id'

const PROVIDER_SESSION_ID = '019feb51-2269-71c2-89c6-faa8dc65c8dd'

test.describe.configure({ mode: 'serial' })

async function findSecondaryWorktree(
  page: Page,
  client: RuntimeClient,
  coordinatorWorktreeId: string
): Promise<string> {
  let targetWorktreeId: string | null = null
  await expect
    .poll(
      async () => {
        const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
        // The restart fixture only waits for the primary; refetch until the seeded secondary lands.
        const rendererWorktreeIds = await page.evaluate(async () => {
          const store = window.__store
          if (!store) {
            return []
          }
          await Promise.all(
            store.getState().repos.map((repo) => store.getState().fetchWorktrees(repo.id))
          )
          return Object.values(store.getState().worktreesByRepo)
            .flat()
            .map((worktree) => worktree.id)
        })
        targetWorktreeId =
          listed.result.worktrees.find(
            (worktree) =>
              worktree.id !== coordinatorWorktreeId && rendererWorktreeIds.includes(worktree.id)
          )?.id ?? null
        return targetWorktreeId
      },
      { timeout: 60_000, message: 'runtime never registered the secondary worktree' }
    )
    .not.toBeNull()
  if (!targetWorktreeId) {
    throw new Error('The seeded repository did not expose its secondary worktree')
  }
  return targetWorktreeId
}

async function backgroundMountTab(page: Page, worktreeId: string, tabId: string): Promise<void> {
  await page.evaluate(
    ({ tabId, worktreeId }) => {
      window.dispatchEvent(
        new CustomEvent('orca-background-mount-terminal-worktree', {
          detail: { worktreeId, tabIds: [tabId] }
        })
      )
    },
    { tabId, worktreeId }
  )
  await expect
    .poll(() => page.evaluate((tabId) => Boolean(window.__paneManagers?.get(tabId)), tabId))
    .toBe(true)
}

function readPersistedSession(userDataDir: string) {
  return JSON.parse(
    readFileSync(
      path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json'),
      'utf8'
    )
  ).workspaceSession
}

function expectNoPersistedWorkerFence(userDataDir: string, paneKey: string): void {
  const persisted = readPersistedSession(userDataDir)
  // Keep the baseline running through reveal even when it still writes the withdrawn policy.
  expect
    .soft(persisted.sleepingAgentSessionsByPaneKey?.[paneKey] ?? {})
    .not.toHaveProperty('automaticResumeBlockedBy')
  expect.soft(persisted.legacyWorkerResumeFencesByPaneKey ?? {}).not.toHaveProperty(paneKey)
}

// A restored worker must attach through main so revealing it never fabricates a missing PTY.
for (const daemonSessionGone of [false, true]) {
  test(`a settled worker tab survives restart with daemon session ${daemonSessionGone ? 'exited' : 'live'}`, async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    test.setTimeout(300_000)
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }
    clearCompletedWorkerLedger()

    const session = createRestartSession(testInfo, completedWorkerLaunchEnv)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null
    try {
      const first = await session.launch()
      firstApp = first.app
      const coordinatorWorktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
      await waitForSessionReady(first.page)
      await waitForActiveWorktree(first.page)
      await ensureTerminalVisible(first.page)
      await waitForActiveTerminalManager(first.page)
      await waitForActivePanePtyId(first.page)
      await first.page.evaluate(
        async ({ agentCommand, terminalWindowsShell }) => {
          await window.__store?.getState().updateSettings({
            agentCmdOverrides: { codex: agentCommand },
            terminalWindowsShell,
            disabledTuiAgents: [],
            terminalHiddenViewParking: false
          })
        },
        {
          agentCommand: completedWorkerFakeCodexCommand,
          terminalWindowsShell: FAKE_AGENT_WINDOWS_SHELL
        }
      )
      const isolatedHome = await firstApp.evaluate(({ app }) => app.getPath('home'))
      const client = new RuntimeClient(session.userDataDir, 30_000, null, null)
      const coordinatorPane = await waitForActivePaneHookDescriptor(first.page)
      const coordinatorHandle = (
        await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
          paneKey: coordinatorPane.paneKey
        })
      ).result.terminal.handle
      const targetWorktreeId = await findSecondaryWorktree(
        first.page,
        client,
        coordinatorWorktreeId
      )
      const targetWorktreePath = splitWorktreeIdForFilesystem(targetWorktreeId)?.worktreePath
      if (!targetWorktreePath) {
        throw new Error('The secondary worktree did not expose a filesystem path')
      }

      const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
        objective: 'Keep one settled worker tab across restart',
        from: coordinatorHandle
      })
      const task = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
        spec: 'Report completion and stay open',
        run: run.result.run.id,
        callerTerminalHandle: coordinatorHandle
      })
      const started = await client.call<{
        dispatchId: string
        state: string
        effects: { kind: string; role?: string; id?: string }[]
      }>('orchestration.workerStart', {
        task: task.result.task.id,
        from: coordinatorHandle,
        worktree: `id:${targetWorktreeId}`,
        agent: 'codex',
        timeoutMs: 30_000
      })
      expect(started.result.state).toBe('ready')
      const workerHandle = started.result.effects.find(
        (effect) => effect.kind === 'terminal' && effect.role === 'agent'
      )?.id
      if (!workerHandle) {
        throw new Error('worker-start did not return its agent terminal')
      }
      let worker: RuntimeTerminalSummary | undefined
      await expect
        .poll(
          async () => {
            worker = (await listRuntimeTerminals(client)).find(
              (terminal) => terminal.handle === workerHandle
            )
            return worker?.ptyId ?? null
          },
          { timeout: 30_000, message: 'background worker never published its PTY identity' }
        )
        .not.toBeNull()
      if (!worker?.ptyId) {
        throw new Error('Background worker did not publish its PTY')
      }
      const workerPtyId = worker.ptyId
      const workerTabId = worker.tabId
      const workerPaneKey = `${worker.tabId}:${worker.leafId}`
      await backgroundMountTab(first.page, targetWorktreeId, workerTabId)
      let dispatchCapability: string | null = null
      await expect
        .poll(() => {
          dispatchCapability = readCompletedWorkerDispatchCapability()
          return dispatchCapability
        })
        .not.toBeNull()
      if (!dispatchCapability) {
        throw new Error('Background worker did not receive its dispatch capability')
      }
      const transcriptPath = seedCurrentCodexTranscript(
        isolatedHome,
        PROVIDER_SESSION_ID,
        targetWorktreePath
      )
      await first.page.evaluate(
        ({
          agentCommand,
          paneKey,
          providerSessionId,
          tabId,
          terminalHandle,
          transcriptPath,
          worktreeId
        }) => {
          const state = window.__store?.getState()
          if (!state) {
            throw new Error('Renderer store unavailable')
          }
          const metadata = { tabId, worktreeId, terminalHandle }
          const recovery = {
            providerSession: { key: 'session_id' as const, id: providerSessionId, transcriptPath },
            launchConfig: {
              agentCommand,
              agentArgs: '--dangerously-bypass-approvals-and-sandbox',
              agentEnv: {}
            }
          }
          for (const agentState of ['working', 'done'] as const) {
            state.setAgentStatus(
              paneKey,
              { state: agentState, prompt: 'Report completion and stay open', agentType: 'codex' },
              'Settled background worker',
              undefined,
              metadata,
              recovery
            )
          }
        },
        {
          agentCommand: completedWorkerFakeCodexCommand,
          paneKey: workerPaneKey,
          providerSessionId: PROVIDER_SESSION_ID,
          tabId: workerTabId,
          terminalHandle: workerHandle,
          transcriptPath,
          worktreeId: targetWorktreeId
        }
      )
      const completed = await client.call<{ message: { type: string } }>(
        'orchestration.send',
        {
          from: workerHandle,
          subject: 'Completed',
          body: 'The fixture completed and stays open for inspection.',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: task.result.task.id,
            dispatchId: started.result.dispatchId,
            outcome: 'succeeded'
          })
        },
        { orchestrationCapability: dispatchCapability }
      )
      expect(completed.result.message.type).toBe('worker_done')
      const taskBeforeRestart = (
        await client.call('orchestration.taskList', { run: run.result.run.id })
      ).result
      const dispatchBeforeRestart = (
        await client.call('orchestration.dispatchShow', { task: task.result.task.id })
      ).result

      await session.close(firstApp)
      firstApp = null
      expectNoPersistedWorkerFence(session.userDataDir, workerPaneKey)
      expect(readCompletedWorkerLedger().filter((event) => event.event === 'normal-exit')).toEqual(
        []
      )

      const launchesBeforeRestart = readCompletedWorkerLedger().filter(
        (event) => event.event === 'spawn'
      )
      if (daemonSessionGone) {
        const daemonDir = path.join(session.userDataDir, 'daemon')
        const daemon = new DaemonClient({
          socketPath: getDaemonSocketPath(daemonDir),
          tokenPath: getDaemonTokenPath(daemonDir)
        })
        try {
          await daemon.ensureConnected()
          await daemon.request('kill', { sessionId: workerPtyId, immediate: true })
          await expect
            .poll(async () => {
              const result = await daemon.request<{ sessions: { sessionId: string }[] }>(
                'listSessions',
                undefined
              )
              return result.sessions.some((entry) => entry.sessionId === workerPtyId)
            })
            .toBe(false)
        } finally {
          daemon.disconnect()
        }
      }
      const second = await session.launch()
      secondApp = second.app
      await waitForSessionReady(second.page)
      if (!daemonSessionGone) {
        // The restarted runtime must rediscover the daemon-owned worker before reveal.
        await expect
          .poll(
            async () =>
              (await listRuntimeTerminals(client)).find(
                (terminal) => terminal.ptyId === workerPtyId
              )?.connected ?? null,
            { timeout: 60_000, message: 'restarted runtime never rediscovered the worker PTY' }
          )
          .toBe(true)
      }
      expect(
        await second.page.evaluate(
          ({ tabId, worktreeId }) =>
            Boolean(
              window.__store?.getState().tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)
            ),
          { tabId: workerTabId, worktreeId: targetWorktreeId }
        )
      ).toBe(true)

      // Hidden mount, then click to reveal: reveal runs the missing-session reconciler.
      await backgroundMountTab(second.page, targetWorktreeId, workerTabId)
      // Poll, don't sample: main's cache learns the session when the pane's deferred reattach lands,
      // and backgroundMountTab only waits for the pane manager to exist. A restarted main that never
      // attaches stays false for the whole window, which is the regression this guards.
      if (!daemonSessionGone) {
        await expect
          .configure({ soft: true })
          .poll(() => second.page.evaluate((ptyId) => window.api.pty.hasPty(ptyId), workerPtyId), {
            timeout: 20_000,
            message: 'liveness before reveal'
          })
          .toBe(true)
      }
      await second.page.evaluate(
        ({ tabId, worktreeId }) => {
          const store = window.__store
          if (!store) {
            throw new Error('Renderer store unavailable')
          }
          type Transition = {
            activeWorktreeId: string | null
            tabPresent: boolean
            leafPtyIds: string[]
            activeTabId: string | null
          }
          const snapshot = (state: ReturnType<typeof store.getState>): Transition => ({
            activeWorktreeId: state.activeWorktreeId ?? null,
            tabPresent: Boolean(state.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)),
            leafPtyIds: Object.values(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}),
            activeTabId: state.activeTabIdByWorktree[worktreeId] ?? null
          })
          const transitions: Transition[] = [snapshot(store.getState())]
          const e2eWindow = window as typeof window & { __orcaRevealTransitions?: Transition[] }
          e2eWindow.__orcaRevealTransitions = transitions
          store.subscribe((state) => {
            const next = snapshot(state)
            if (JSON.stringify(next) !== JSON.stringify(transitions.at(-1))) {
              transitions.push(next)
            }
          })
        },
        { tabId: workerTabId, worktreeId: targetWorktreeId }
      )
      await second.page
        .locator(`[role="option"][data-worktree-id="${targetWorktreeId}"]`)
        .first()
        .click()
      const visibleTab = second.page
        .locator(`[data-testid="sortable-tab"][data-tab-id="${workerTabId}"]`)
        .first()
      await visibleTab.click({ timeout: 10_000 })
      await expect(visibleTab).toBeVisible()
      await ensureTerminalVisible(second.page)
      // Give the reconciler's async verdict time to land; the tab must never have left.
      await second.page.waitForTimeout(3_000)
      const transitions = await second.page.evaluate(
        () =>
          (
            window as typeof window & {
              __orcaRevealTransitions?: {
                activeWorktreeId: string | null
                tabPresent: boolean
                leafPtyIds: string[]
              }[]
            }
          ).__orcaRevealTransitions ?? []
      )
      // Pre-fix this read: leaf binding cleared -> tab removed -> worktree deselected -> tab re-added by graph sync.
      expect(
        transitions.filter(
          (step) => !step.tabPresent || (!daemonSessionGone && step.leafPtyIds.length === 0)
        ),
        'reveal must not tear the settled worker tab down'
      ).toEqual([])
      expect(transitions.at(-1)?.activeWorktreeId).toBe(targetWorktreeId)
      expect(
        await second.page.evaluate(
          (tabId) => Boolean(window.__paneManagers?.get(tabId)),
          workerTabId
        )
      ).toBe(true)
      if (!daemonSessionGone) {
        expect(
          (await listRuntimeTerminals(client)).find((terminal) => terminal.ptyId === workerPtyId)
            ?.connected
        ).toBe(true)
        expect(
          readCompletedWorkerLedger().filter((event) => event.event === 'normal-exit')
        ).toEqual([])
      }
      const newLaunches = readCompletedWorkerLedger()
        .filter((event) => event.event === 'spawn')
        .slice(launchesBeforeRestart.length)
      if (daemonSessionGone) {
        expect(newLaunches.length).toBeLessThanOrEqual(1)
        for (const launch of newLaunches) {
          // Codex's --resume equivalent is the `resume <session-id>` subcommand.
          expect(launch.args).toContain('resume')
          expect(launch.args).toContain(PROVIDER_SESSION_ID)
        }
        const listed = await client.call<{
          workers: { dispatchId: string; terminalState: string; workerState: string }[]
        }>('orchestration.workerList', { run: run.result.run.id })
        await testInfo.attach('resumed-worker-accounting', {
          body: JSON.stringify({ newLaunches, workers: listed.result.workers }),
          contentType: 'application/json'
        })
        expect(listed.result.workers).toEqual([
          expect.objectContaining({
            dispatchId: started.result.dispatchId,
            terminalState: 'retained',
            workerState: 'succeeded'
          })
        ])
      } else {
        expect(newLaunches).toEqual([])
        expect(
          await second.page.evaluate((ptyId) => window.api.pty.hasPty(ptyId), workerPtyId)
        ).toBe(true)
      }
      expect(readCompletedWorkerLedger().filter((event) => event.event === 'normal-exit')).toEqual(
        []
      )
      expect(
        (await client.call('orchestration.taskList', { run: run.result.run.id })).result
      ).toEqual(taskBeforeRestart)
      expect(
        (await client.call('orchestration.dispatchShow', { task: task.result.task.id })).result
      ).toEqual(dispatchBeforeRestart)
      await expect(visibleTab).toBeVisible()
      const paneKeys = await second.page.evaluate((tabId) => {
        const layout = window.__store?.getState().terminalLayoutsByTabId[tabId]
        const leaves: string[] = []
        const visit = (node: NonNullable<typeof layout>['root']) => {
          if (node.type === 'leaf') {
            leaves.push(`${tabId}:${node.leafId}`)
          } else {
            visit(node.first)
            visit(node.second)
          }
        }
        if (layout?.root) {
          visit(layout.root)
        }
        return leaves
      }, workerTabId)
      expect(paneKeys).toContain(workerPaneKey)
      expect(
        await secondApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused()
          }))
        )
      ).toEqual([{ visible: false, focused: false }])
      await second.page.screenshot({ path: testInfo.outputPath('settled-worker-revealed.png') })
      await session.close(secondApp)
      secondApp = null
      const persisted = readPersistedSession(session.userDataDir)
      expectNoPersistedWorkerFence(session.userDataDir, workerPaneKey)
      expect(
        persisted.tabsByWorktree[targetWorktreeId].some(
          (tab: { id: string }) => tab.id === workerTabId
        )
      ).toBe(true)
      expect(persisted.terminalLayoutsByTabId[workerTabId]).toBeDefined()
      if (!daemonSessionGone) {
        expect(
          Object.values(persisted.terminalLayoutsByTabId[workerTabId].ptyIdsByLeafId)
        ).toContain(workerPtyId)
      }
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
}
