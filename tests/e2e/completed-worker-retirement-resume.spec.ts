import { test as base, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  cleanupCompletedWorkerFixture,
  clearCompletedWorkerLedger,
  completedWorkerFakeCodexCommand,
  completedWorkerLaunchEnv,
  listRuntimeTerminals,
  readCompletedWorkerDispatchCapability,
  readCompletedWorkerLedger,
  readPersistedWorkerRecoveryRecord,
  runBuiltOrcaCli,
  seedCurrentCodexTranscript,
  terminalIdentity
} from './helpers/completed-worker-retirement-fixture'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalRead, RuntimeTerminalSummary } from '../../src/shared/runtime-types'
import { splitWorktreeIdForFilesystem } from '../../src/shared/worktree/id'

const PROVIDER_SESSION_ID = '019feb51-2269-71c2-89c6-faa8dc65c8dc'

const test = base.extend({
  launchEnv: [completedWorkerLaunchEnv, { option: true }]
})

test.describe.configure({ mode: 'serial' })

test.afterAll(() => {
  cleanupCompletedWorkerFixture()
})

for (const closeMode of ['terminal-close-cli', 'worker-release'] as const) {
  test(`completed background worker ${closeMode} retires resume authority before first activation`, async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    clearCompletedWorkerLedger()
    await waitForSessionReady(orcaPage)
    const coordinatorWorktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    await waitForActivePanePtyId(orcaPage)
    await orcaPage.evaluate(async (agentCommand) => {
      await window.__store?.getState().updateSettings({
        agentCmdOverrides: { codex: agentCommand },
        disabledTuiAgents: [],
        terminalHiddenViewParking: false
      })
    }, completedWorkerFakeCodexCommand)

    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
    const client = new RuntimeClient(userDataDir, 30_000, null, null)
    const coordinatorPane = await waitForActivePaneHookDescriptor(orcaPage)
    const coordinatorResolved = await client.call<{ terminal: { handle: string } }>(
      'terminal.resolvePane',
      { paneKey: coordinatorPane.paneKey }
    )
    const coordinatorHandle = coordinatorResolved.result.terminal.handle
    const coordinator = (await listRuntimeTerminals(client)).find(
      (terminal) => terminal.handle === coordinatorHandle
    )
    if (!coordinator) {
      throw new Error('Coordinator terminal was not runtime-visible')
    }
    const coordinatorBefore = terminalIdentity(coordinator)

    let targetWorktreeId: string | null = null
    await expect
      .poll(
        async () => {
          const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
          const rendererWorktreeIds = await orcaPage.evaluate(() =>
            Object.values(window.__store?.getState().worktreesByRepo ?? {})
              .flat()
              .map((worktree) => worktree.id)
          )
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
    const targetWorktreePath = splitWorktreeIdForFilesystem(targetWorktreeId)?.worktreePath
    if (!targetWorktreePath) {
      throw new Error('The secondary worktree did not expose a filesystem path')
    }

    expect(
      await orcaPage.evaluate(
        (worktreeId) => window.__store?.getState().everActivatedWorktreeIds.has(worktreeId),
        targetWorktreeId
      )
    ).toBe(false)

    const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: 'Retire one completed background worker',
      from: coordinatorHandle
    })
    const task = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
      spec: 'Report completion, then exit normally',
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
      worktree: `id:${String(targetWorktreeId)}`,
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
    if (!worker?.ptyId || !worker.incarnationId) {
      throw new Error('Background worker did not publish exact PTY identity')
    }
    const workerBefore = terminalIdentity(worker)
    const workerPaneKey = `${worker.tabId}:${worker.leafId}`
    expect(worker.worktreeId).toBe(targetWorktreeId)
    await orcaPage.evaluate(
      ({ tabId, worktreeId }) => {
        window.dispatchEvent(
          new CustomEvent('orca-background-mount-terminal-worktree', {
            detail: { worktreeId, tabIds: [tabId] }
          })
        )
      },
      { tabId: worker.tabId, worktreeId: targetWorktreeId }
    )
    await expect
      .poll(() =>
        orcaPage.evaluate((tabId) => Boolean(window.__paneManagers?.get(tabId)), workerBefore.tabId)
      )
      .toBe(true)
    expect(
      await orcaPage.evaluate(
        (worktreeId) => window.__store?.getState().everActivatedWorktreeIds.has(worktreeId),
        targetWorktreeId
      )
    ).toBe(false)
    await expect
      .poll(() => readCompletedWorkerLedger().filter((event) => event.event === 'spawn'))
      .toHaveLength(1)
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

    await orcaPage.evaluate(
      ({ paneKey, providerSessionId, tabId, terminalHandle, transcriptPath, worktreeId }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Renderer store unavailable')
        }
        const providerSession = {
          key: 'session_id' as const,
          id: providerSessionId,
          transcriptPath
        }
        const metadata = { tabId, worktreeId, terminalHandle }
        const recovery = {
          providerSession,
          launchConfig: {
            agentCommand: 'codex',
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          }
        }
        state.setAgentStatus(
          paneKey,
          { state: 'working', prompt: 'Report completion, then exit normally', agentType: 'codex' },
          'Completed background worker',
          undefined,
          metadata,
          recovery
        )
        state.setAgentStatus(
          paneKey,
          { state: 'done', prompt: 'Report completion, then exit normally', agentType: 'codex' },
          'Completed background worker',
          undefined,
          metadata,
          recovery
        )
      },
      {
        paneKey: workerPaneKey,
        providerSessionId: PROVIDER_SESSION_ID,
        tabId: worker.tabId,
        terminalHandle: workerHandle,
        transcriptPath,
        worktreeId: targetWorktreeId
      }
    )

    const expectedRecovery = {
      origin: 'live',
      state: 'working',
      providerSessionId: PROVIDER_SESSION_ID
    }
    await expect
      .poll(() =>
        orcaPage.evaluate((paneKey) => {
          const record = window.__store?.getState().sleepingAgentSessionsByPaneKey[paneKey]
          return record
            ? {
                origin: record.origin,
                state: record.state,
                providerSessionId: record.providerSession.id
              }
            : null
        }, workerPaneKey)
      )
      .toEqual(expectedRecovery)
    await expect
      .poll(
        () => {
          const record = readPersistedWorkerRecoveryRecord(userDataDir, workerPaneKey)
          return record
            ? {
                origin: record.origin,
                state: record.state,
                providerSessionId: record.providerSession?.id
              }
            : null
        },
        { timeout: 30_000 }
      )
      .toEqual(expectedRecovery)

    const completed = await client.call<{ message: { type: string } }>(
      'orchestration.send',
      {
        from: workerHandle,
        subject: 'Completed',
        body: 'The fixture completed. It found no work. Nothing remains.',
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
    await expect
      .poll(
        async () => {
          const dispatch = await client.call<{ dispatch: { status: string } | null }>(
            'orchestration.dispatchShow',
            { task: task.result.task.id }
          )
          const tasks = await client.call<{ tasks: { id: string; status: string }[] }>(
            'orchestration.taskList',
            { run: run.result.run.id }
          )
          return {
            dispatch: dispatch.result.dispatch?.status ?? null,
            task:
              tasks.result.tasks.find((candidate) => candidate.id === task.result.task.id)
                ?.status ?? null
          }
        },
        { timeout: 30_000, message: 'worker completion never settled its task and dispatch' }
      )
      .toEqual({ dispatch: 'completed', task: 'completed' })

    await client.call('terminal.send', {
      terminal: workerHandle,
      text: 'ORCA_E2E_EXIT_AFTER_DONE',
      enter: true
    })
    await expect
      .poll(() => readCompletedWorkerLedger().filter((event) => event.event === 'normal-exit'))
      .toHaveLength(1)
    expect(
      await orcaPage.evaluate(
        ({ paneKey, tabId, worktreeId }) => {
          const state = window.__store?.getState()
          return {
            tabPresent: Boolean(state?.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)),
            recoveryPresent: Boolean(state?.sleepingAgentSessionsByPaneKey[paneKey])
          }
        },
        { paneKey: workerPaneKey, tabId: workerBefore.tabId, worktreeId: targetWorktreeId }
      )
    ).toEqual({ tabPresent: true, recoveryPresent: true })

    await orcaPage.evaluate(
      ({ paneKey, tabId, worktreeId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        type Transition = { tabPresent: boolean; recoveryPresent: boolean }
        const e2eWindow = window as typeof window & {
          __orcaRetiredWorkerTransitions?: Transition[]
          __orcaRetiredWorkerUnsubscribe?: () => void
        }
        const transitions: Transition[] = [
          {
            tabPresent: Boolean(
              store.getState().tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)
            ),
            recoveryPresent: Boolean(store.getState().sleepingAgentSessionsByPaneKey[paneKey])
          }
        ]
        e2eWindow.__orcaRetiredWorkerTransitions = transitions
        e2eWindow.__orcaRetiredWorkerUnsubscribe = store.subscribe((state) => {
          const next = {
            tabPresent: Boolean(state.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)),
            recoveryPresent: Boolean(state.sleepingAgentSessionsByPaneKey[paneKey])
          }
          const previous = transitions.at(-1)
          if (
            !previous ||
            previous.tabPresent !== next.tabPresent ||
            previous.recoveryPresent !== next.recoveryPresent
          ) {
            transitions.push(next)
          }
        })
      },
      { paneKey: workerPaneKey, tabId: workerBefore.tabId, worktreeId: targetWorktreeId }
    )

    if (closeMode === 'terminal-close-cli') {
      const closed = runBuiltOrcaCli(['terminal', 'close', '--terminal', workerHandle, '--json'], {
        userDataDir,
        cwd: process.cwd()
      })
      expect(closed).toMatchObject({
        ok: true,
        result: {
          close: {
            handle: workerHandle,
            tabId: workerBefore.tabId,
            ptyKilled: true
          }
        }
      })
    } else {
      const release = await client.call<{
        dispatchId: string
        state: string
        processAction: string
      }>('orchestration.workerRelease', { dispatch: started.result.dispatchId })
      expect(release.result).toMatchObject({
        dispatchId: started.result.dispatchId,
        state: 'released',
        processAction: 'closed_agent_terminal'
      })
    }
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          type Transition = { tabPresent: boolean; recoveryPresent: boolean }
          return (window as typeof window & { __orcaRetiredWorkerTransitions?: Transition[] })
            .__orcaRetiredWorkerTransitions
        })
      )
      .toEqual(
        expect.arrayContaining([
          { tabPresent: true, recoveryPresent: true },
          { tabPresent: false, recoveryPresent: false }
        ])
      )
    await orcaPage.evaluate(() => {
      const e2eWindow = window as typeof window & { __orcaRetiredWorkerUnsubscribe?: () => void }
      e2eWindow.__orcaRetiredWorkerUnsubscribe?.()
      delete e2eWindow.__orcaRetiredWorkerUnsubscribe
    })
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (paneKey) => window.__store?.getState().sleepingAgentSessionsByPaneKey[paneKey] ?? null,
          workerPaneKey
        )
      )
      .toBeNull()

    await orcaPage.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
    await expect
      .poll(() =>
        orcaPage.evaluate(async (paneKey) => {
          const session = await window.api.session.get()
          return session.sleepingAgentSessionsByPaneKey?.[paneKey] ?? null
        }, workerPaneKey)
      )
      .toBeNull()
    await orcaPage.evaluate(() => window.api.session.flush())
    expect(readPersistedWorkerRecoveryRecord(userDataDir, workerPaneKey)).toBeNull()

    await orcaPage.reload()
    await waitForSessionReady(orcaPage)

    const beforeActivation = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      return {
        everActivated: state?.everActivatedWorktreeIds.has(worktreeId) ?? false,
        tabCount: state?.tabsByWorktree[worktreeId]?.length ?? 0,
        pendingStartupCount: Object.keys(state?.pendingStartupByTabId ?? {}).length
      }
    }, targetWorktreeId)
    expect(beforeActivation).toEqual({ everActivated: false, tabCount: 0, pendingStartupCount: 0 })

    const targetCard = orcaPage
      .locator(`[data-worktree-id="${String(targetWorktreeId)}"]`)
      .first()
      .locator('[data-worktree-card-surface]')
    await targetCard.evaluate((element: HTMLElement) => element.click())
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId))
      .toBe(targetWorktreeId)
    await waitForActiveTerminalManager(orcaPage)
    await waitForActivePanePtyId(orcaPage)
    const activatedPane = await waitForActivePaneHookDescriptor(orcaPage)
    expect(activatedPane.worktreeId).toBe(targetWorktreeId)
    const activatedResolved = await client.call<{ terminal: { handle: string } }>(
      'terminal.resolvePane',
      { paneKey: activatedPane.paneKey }
    )
    await expect
      .poll(
        async () => {
          const read = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
            terminal: activatedResolved.result.terminal.handle,
            limit: 50
          })
          return read.result.terminal.tail.join('\n')
        },
        { timeout: 30_000, message: 'activated fallback terminal never produced output' }
      )
      .not.toBe('')

    const spawnEvents = readCompletedWorkerLedger().filter((event) => event.event === 'spawn')
    expect(spawnEvents).toHaveLength(1)
    expect(
      spawnEvents.filter(
        (event) => event.args?.includes('resume') && event.args?.includes(PROVIDER_SESSION_ID)
      )
    ).toEqual([])
    await expect(orcaPage.locator('.session-restored-banner')).toHaveCount(0)

    const afterActivation = await orcaPage.evaluate(
      ({ originalTabId, worktreeId }) => {
        const state = window.__store?.getState()
        const tabs = state?.tabsByWorktree[worktreeId] ?? []
        return {
          everActivated: state?.everActivatedWorktreeIds.has(worktreeId) ?? false,
          originalTabPresent: tabs.some((tab) => tab.id === originalTabId),
          replacementTabCount: tabs.filter((tab) => tab.id !== originalTabId).length,
          pendingResumeSessionIds: Object.values(state?.pendingStartupByTabId ?? {}).flatMap(
            (startup) => (startup.resumeProviderSession ? [startup.resumeProviderSession.id] : [])
          ),
          resumeClaimCount: Object.keys(state?.automaticAgentResumeClaimsByTabId ?? {}).length
        }
      },
      { originalTabId: workerBefore.tabId, worktreeId: targetWorktreeId }
    )
    expect(afterActivation).toEqual({
      everActivated: true,
      originalTabPresent: false,
      replacementTabCount: 1,
      pendingResumeSessionIds: [],
      resumeClaimCount: 0
    })

    const coordinatorAfter = (await listRuntimeTerminals(client)).find(
      (terminal) => terminal.handle === coordinatorHandle
    )
    expect(coordinatorAfter ? terminalIdentity(coordinatorAfter) : null).toEqual(coordinatorBefore)
    expect(coordinatorAfter?.worktreeId).toBe(coordinatorWorktreeId)
  })
}
