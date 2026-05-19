import { test, expect } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { getRendererTitleLog, installRendererTitleLog } from './helpers/terminal-title-log'
import {
  sendToTerminal,
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

async function getAgentStatuses(page: Page): Promise<
  {
    paneKey: string
    state: string
    agentType?: string
    prompt?: string
    lastAssistantMessage?: string
  }[]
> {
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

async function getActivePaneDescriptor(
  page: Page
): Promise<{ paneKey: string; worktreeId: string }> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree')
    }
    const tabId = state.activeTabIdByWorktree[worktreeId] ?? state.activeTabId
    if (!tabId) {
      throw new Error('No active tab')
    }
    const manager = window.__paneManagers?.get(tabId)
    const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    const leafId = activePane ? manager?.getLeafIdMap?.().get(activePane.id) : null
    if (!leafId) {
      throw new Error('No active pane leaf id')
    }
    return { paneKey: `${tabId}:${leafId}`, worktreeId }
  })
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

    const { paneKey, worktreeId } = await getActivePaneDescriptor(orcaPage)
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
          (await getAgentStatuses(orcaPage)).some(
            (status) =>
              status.agentType === 'codex' && status.state === 'working' && status.prompt === prompt
          ),
        {
          timeout: 10_000,
          message: 'Codex UserPromptSubmit hook did not reach renderer agent status'
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
          timeout: 10_000,
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
          timeout: 10_000,
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
    await emitOscTitle(orcaPage, ptyId, 'Codex done')

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
