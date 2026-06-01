/* eslint-disable max-lines -- Why: this e2e shares one Electron notification spy and hook endpoint setup across related notification regressions. */
import { test, expect } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { getRendererTitleLog, installRendererTitleLog } from './helpers/terminal-title-log'
import {
  sendToTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'

type NotificationDispatch = {
  source?: string
  terminalTitle?: string
  paneKey?: string
  isActiveWorktree?: boolean
  agentType?: string
  agentPrompt?: string
  agentLastAssistantMessage?: string
}

type AgentStatusSummary = {
  paneKey: string
  state: string
  agentType?: string
  prompt?: string
  lastAssistantMessage?: string
}

async function emitOscTitle(page: Page, ptyId: string, title: string) {
  await sendToTerminal(page, ptyId, `printf '\\033]0;${title}\\007'\r`)
}

async function installMainProcessNotificationDispatchSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as {
      __notificationDispatchLog?: NotificationDispatch[]
      __notificationDispatchSpyInstalled?: boolean
    }
    if (g.__notificationDispatchSpyInstalled) {
      return
    }
    g.__notificationDispatchLog = []
    g.__notificationDispatchSpyInstalled = true
    ipcMain.removeHandler('notifications:dispatch')
    ipcMain.handle('notifications:dispatch', (_event: unknown, args: NotificationDispatch) => {
      g.__notificationDispatchLog!.push(args)
      return { delivered: true }
    })
  })
}

async function getNotificationDispatches(
  app: ElectronApplication
): Promise<NotificationDispatch[]> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __notificationDispatchLog?: NotificationDispatch[] }
    return g.__notificationDispatchLog ?? []
  })
}

async function switchToOtherExistingWorktree(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const activeWorktreeId = state.activeWorktreeId
    if (!activeWorktreeId) {
      throw new Error('No active worktree')
    }
    const activeWorktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === activeWorktreeId)
    if (!activeWorktree) {
      throw new Error(`Active worktree ${activeWorktreeId} not found`)
    }
    const otherWorktree =
      Object.values(state.worktreesByRepo)
        .flat()
        .find(
          (worktree) =>
            worktree.repoId === activeWorktree.repoId &&
            worktree.id !== activeWorktreeId &&
            worktree.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary'
        ) ??
      Object.values(state.worktreesByRepo)
        .flat()
        .find(
          (worktree) =>
            worktree.repoId === activeWorktree.repoId && worktree.id !== activeWorktreeId
        )
    if (!otherWorktree) {
      throw new Error(`No inactive worktree found for repo ${activeWorktree.repoId}`)
    }
    state.setActiveWorktree(otherWorktree.id)
    return otherWorktree.id
  })
}

async function getAgentStatuses(page: Page): Promise<AgentStatusSummary[]> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return []
    }
    return Object.values(store.getState().agentStatusByPaneKey ?? {}).map((entry) => ({
      paneKey: entry.paneKey,
      state: entry.state,
      agentType: entry.agentType,
      prompt: entry.prompt,
      lastAssistantMessage: entry.lastAssistantMessage
    }))
  })
}

async function getCachedAgentStatuses(page: Page): Promise<AgentStatusSummary[]> {
  return page.evaluate(async () => {
    const snapshot = await window.api.agentStatus.getSnapshot()
    return snapshot.map((entry) => ({
      paneKey: entry.paneKey,
      state: entry.state,
      agentType: entry.agentType,
      prompt: entry.prompt,
      lastAssistantMessage: entry.lastAssistantMessage
    }))
  })
}

async function getRendererOrCachedAgentStatuses(page: Page): Promise<AgentStatusSummary[]> {
  const [rendererStatuses, cachedStatuses] = await Promise.all([
    getAgentStatuses(page),
    getCachedAgentStatuses(page)
  ])
  return [...rendererStatuses, ...cachedStatuses]
}

async function isWorktreeUnread(page: Page, worktreeId: string): Promise<boolean> {
  return page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      return false
    }
    return (
      Object.values(store.getState().worktreesByRepo)
        .flat()
        .find((worktree) => worktree.id === targetWorktreeId)?.isUnread === true
    )
  }, worktreeId)
}

test.describe('Droid notifications', () => {
  test('Codex hook completion dispatches while its worktree is inactive', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installMainProcessNotificationDispatchSpy(electronApp)
    const endpoint = await readHookEndpoint(electronApp)

    // Why: the synthetic hook bypasses the shell startup path; wait for a
    // responsive PTY so the notification liveness gate can observe the turn.
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const readyMarker = `__CODEX_HOOK_NOTIFY_READY_${Date.now()}__`
    await sendToTerminal(orcaPage, ptyId, `printf '${readyMarker}\\n'\r`)
    await waitForTerminalOutput(orcaPage, readyMarker)

    const { paneKey, worktreeId } = await waitForActivePaneHookDescriptor(orcaPage)
    const prompt = `codex-hook-notify-${Date.now()}`
    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'working',
      prompt
    })
    await expect
      .poll(
        async () =>
          (await getRendererOrCachedAgentStatuses(orcaPage)).some(
            (status) =>
              status.agentType === 'codex' && status.state === 'working' && status.prompt === prompt
          ),
        {
          timeout: 30_000,
          // Why: this synthetic hook posts directly to main; main's cache is
          // the durable source used to recover renderer startup/listener races.
          message: 'Codex UserPromptSubmit hook did not reach agent status cache'
        }
      )
      .toBe(true)

    await switchToOtherExistingWorktree(orcaPage)

    const finalMessage = `Codex hook completed ${Date.now()}`
    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'done',
      prompt,
      lastAssistantMessage: finalMessage
    })
    await expect
      .poll(
        async () =>
          (await getAgentStatuses(orcaPage)).some(
            (status) =>
              status.agentType === 'codex' &&
              status.state === 'done' &&
              status.prompt === prompt &&
              status.lastAssistantMessage === finalMessage
          ),
        {
          timeout: 30_000,
          message: 'Codex Stop hook did not reach renderer agent status'
        }
      )
      .toBe(true)

    await expect
      .poll(
        async () => {
          const dispatches = await getNotificationDispatches(electronApp)
          return dispatches.filter((dispatch) => dispatch.source === 'agent-task-complete')
        },
        {
          timeout: 30_000,
          message: 'Codex hook Stop did not dispatch task-complete while worktree was inactive'
        }
      )
      .toEqual([
        expect.objectContaining({
          source: 'agent-task-complete',
          terminalTitle: 'codex',
          isActiveWorktree: false,
          agentType: 'codex',
          agentPrompt: prompt,
          agentLastAssistantMessage: finalMessage
        })
      ])

    await expect
      .poll(async () => isWorktreeUnread(orcaPage, worktreeId), {
        timeout: 10_000,
        message: 'Codex hook Stop did not mark the inactive worktree unread'
      })
      .toBe(true)
  })

  test('recognized agent title completion dispatches one task-complete notification', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    // Why: contextBridge freezes window.api, so notification invokes must be
    // observed in Electron's main process rather than monkey-patched renderer-side.
    await installMainProcessNotificationDispatchSpy(electronApp)
    await installRendererTitleLog(orcaPage)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = `__CODEX_NOTIFY_READY_${Date.now()}__`
    await sendToTerminal(orcaPage, ptyId, `printf '${marker}\\n'\r`)
    await waitForTerminalOutput(orcaPage, marker)

    await emitOscTitle(orcaPage, ptyId, 'Codex working')
    await expect
      .poll(async () => (await getRendererTitleLog(orcaPage)).includes('Codex working'), {
        timeout: 10_000,
        message: 'Codex working title did not reach the renderer before completion'
      })
      .toBe(true)

    await emitOscTitle(orcaPage, ptyId, 'Codex done')
    await expect
      .poll(async () => (await getRendererTitleLog(orcaPage)).includes('Codex done'), {
        timeout: 10_000,
        message: 'Codex done title did not reach the renderer'
      })
      .toBe(true)

    await expect
      .poll(
        async () => {
          const dispatches = await getNotificationDispatches(electronApp)
          return dispatches.filter((dispatch) => dispatch.source === 'agent-task-complete')
        },
        {
          timeout: 10_000,
          message: 'Codex working->done title transition did not dispatch task-complete'
        }
      )
      .toEqual([
        expect.objectContaining({ source: 'agent-task-complete', terminalTitle: 'Codex done' })
      ])
  })

  test('Factory Droid needs-input native title does not dispatch a task-complete notification', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    // Why: contextBridge freezes window.api, so notification invokes must be
    // observed in Electron's main process rather than monkey-patched renderer-side.
    await installMainProcessNotificationDispatchSpy(electronApp)
    await installRendererTitleLog(orcaPage)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = `__DROID_NOTIFY_READY_${Date.now()}__`
    await sendToTerminal(orcaPage, ptyId, `printf '${marker}\\n'\r`)
    await waitForTerminalOutput(orcaPage, marker)

    await emitOscTitle(orcaPage, ptyId, '⠋ Droid')
    await emitOscTitle(orcaPage, ptyId, 'Factory Droid needs input')

    await expect
      .poll(
        async () => (await getRendererTitleLog(orcaPage)).includes('Factory Droid needs input'),
        {
          timeout: 10_000,
          message: 'Factory Droid marker title did not land'
        }
      )
      .toBe(true)

    // Why: Factory Droid can show this title while Execute is still running
    // (for example `sleep 180`); hook events own Droid status, not this title.
    await orcaPage.waitForTimeout(500)
    const dispatches = await getNotificationDispatches(electronApp)
    expect(dispatches).toEqual([])
  })
})
