import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { CLAUDE_EVENTS } from '../../src/main/claude/hook-settings'
import type { AgentHookEndpoint } from '../../src/shared/agent-hook-endpoint-file'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from '../../src/renderer/src/runtime/window-visibility-subscription-parking'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_BACKOFF_LIMIT } from '../../src/renderer/src/runtime/window-visibility-subscription-parking'
import { expect, test } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { revealPairedClientWindow } from './helpers/paired-client-window-reveal'

const REQUIRED_CLAUDE_EVENTS = ['UserPromptSubmit', 'Stop', 'PermissionRequest'] as const
const NOTIFICATION_BARRIER_SOURCE = 'sta-5244-barrier'
let completedHideCycles = 0
type NotificationDispatch = {
  source?: string
  agentState?: string
  worktreeId?: string
  attentionRequired?: boolean
}
type AgentStatusSummary = {
  state: string
  prompt: string
  agentType?: string
  toolInput?: unknown
}
type TerminalSurface = Extract<RuntimeMobileSessionTabsResult['tabs'][number], { type: 'terminal' }>
type ClaudeSettings = {
  hooks?: Record<string, { hooks?: { command?: unknown }[] }[]>
}

async function callEnvironment<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  ) as Promise<TResult>
}

async function installNotificationDispatchSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, barrierSource) => {
    const state = globalThis as unknown as { __sta5244Dispatches?: NotificationDispatch[] }
    state.__sta5244Dispatches = []
    ipcMain.removeHandler('notifications:dispatch')
    ipcMain.handle('notifications:dispatch', (_event: unknown, input: NotificationDispatch) => {
      if (input.source === barrierSource) {
        return { delivered: true }
      }
      state.__sta5244Dispatches!.push(input)
      return { delivered: true }
    })
  }, NOTIFICATION_BARRIER_SOURCE)
}

async function notificationDispatches(app: ElectronApplication): Promise<NotificationDispatch[]> {
  return app.evaluate(() => {
    const state = globalThis as unknown as { __sta5244Dispatches?: NotificationDispatch[] }
    return state.__sta5244Dispatches ?? []
  })
}

async function flushNotificationDispatches(page: Page): Promise<void> {
  await page.evaluate(async (source) => {
    const dispatch = window.api.notifications.dispatch as (input: unknown) => Promise<unknown>
    await dispatch({ source })
  }, NOTIFICATION_BARRIER_SOURCE)
}

async function hasManagedClaudeHooks(host: HeadlessPairedRuntimeHost): Promise<boolean> {
  const home = await host.app.evaluate(({ app }) => app.getPath('home'))
  const scriptName = process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
  const scriptPath = path.join(home, '.orca', 'agent-hooks', scriptName)
  const settingsPath = path.join(home, '.claude', 'settings.json')
  if (!existsSync(scriptPath) || !existsSync(settingsPath)) {
    return false
  }
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as ClaudeSettings
  const requiredEvents = new Set<string>([
    ...REQUIRED_CLAUDE_EVENTS,
    ...CLAUDE_EVENTS.map(({ eventName }) => eventName)
  ])
  return [...requiredEvents].every((eventName) =>
    settings.hooks?.[eventName]?.some((definition) =>
      definition.hooks?.some(
        ({ command }) => typeof command === 'string' && command.includes('claude-hook')
      )
    )
  )
}

async function postClaudeHook(
  endpoint: AgentHookEndpoint,
  paneKey: string,
  worktreeId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const [tabId] = paneKey.split(':')
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey,
      tabId,
      worktreeId,
      env: endpoint.env,
      version: endpoint.version,
      payload
    })
  })
  expect(response.status).toBe(204)
}

async function hostSurface(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string,
  parentTabId: string
): Promise<TerminalSurface | null> {
  const snapshot = (
    await host.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree: `id:${worktreeId}`
    })
  ).result
  const surface = snapshot.tabs.find(
    (candidate): candidate is TerminalSurface =>
      candidate.type === 'terminal' && candidate.parentTabId === parentTabId
  )
  return surface ?? null
}

async function clientStatus(page: Page, paneKey: string): Promise<AgentStatusSummary | null> {
  return page.evaluate((key) => {
    const status = window.__store?.getState().agentStatusByPaneKey[key]
    return status
      ? {
          state: status.state,
          prompt: status.prompt,
          agentType: status.agentType,
          toolInput: status.toolInput
        }
      : null
  }, paneKey)
}

async function unreadBadgeState(
  client: PairedElectronClient,
  worktreeId: string
): Promise<{ dock: string | null; unread: boolean; unreadCount: number }> {
  const renderer = await client.page.evaluate((id) => {
    const state = window.__store?.getState()
    const worktrees = state?.allWorktrees() ?? []
    return {
      unread: worktrees.find((worktree) => worktree.id === id)?.isUnread === true,
      unreadCount: worktrees.filter((worktree) => worktree.isUnread).length
    }
  }, worktreeId)
  const dock = await client.app.evaluate(({ app }) => app.dock?.getBadge() ?? null)
  return { ...renderer, dock }
}

async function hideUntilSubscriptionsPark(client: PairedElectronClient): Promise<void> {
  await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide())
  await expect
    .poll(() =>
      client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())
    )
    .toBe(false)
  await client.page.evaluate(() => {
    if (document.visibilityState === 'hidden') {
      return
    }
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden'
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const parkDelay =
    WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS *
    Math.min(2 ** completedHideCycles, WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_BACKOFF_LIMIT)
  await client.page.waitForTimeout(parkDelay + 100)
  completedHideCycles += 1
}

async function revealAfterSubscriptionsPark(client: PairedElectronClient): Promise<void> {
  await client.app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true })
    const window = BrowserWindow.getAllWindows()[0]
    window?.show()
    window?.focus()
  })
  await expect
    .poll(() =>
      client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused())
    )
    .toBe(true)
  await client.page.evaluate(() => {
    if (document.visibilityState === 'visible') {
      return
    }
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible'
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await revealPairedClientWindow(client)
}

async function reconnectAndAwaitReplay(
  client: PairedElectronClient,
  paneKey: string,
  expectedState: string
): Promise<void> {
  const previousGeneration = await client.page.evaluate(
    (environmentId) =>
      window.__store?.getState().runtimeStatusByEnvironmentId.get(environmentId)
        ?.connectionGeneration ?? 0,
    client.environmentId
  )
  await client.page.evaluate(async (selector) => {
    await window.api.runtimeEnvironments.disconnect({ selector })
  }, client.environmentId)
  await expect
    .poll(async () => {
      await client.page.evaluate(
        async (environmentId) =>
          window.__store?.getState().refreshRuntimeEnvironmentStatus(environmentId, 1_000),
        client.environmentId
      )
      return client.page.evaluate((environmentId) => {
        const entry = window.__store?.getState().runtimeStatusByEnvironmentId.get(environmentId)
        return entry === undefined || entry.status === null
      }, client.environmentId)
    })
    .toBe(true)
  await clearClientStatus(client.page, paneKey)
  await expect
    .poll(
      () =>
        client.page.evaluate(async (selector) => {
          const response = await window.api.runtimeEnvironments.connect({ selector })
          return response.ok
        }, client.environmentId),
      { timeout: 60_000, message: 'paired client did not reconnect' }
    )
    .toBe(true)
  await expect
    .poll(async () => {
      await client.page.evaluate(
        async (environmentId) =>
          window.__store?.getState().refreshRuntimeEnvironmentStatus(environmentId, 1_000),
        client.environmentId
      )
      return client.page.evaluate(
        ({ environmentId, previousGeneration }) => {
          const status = window.__store?.getState().runtimeStatusByEnvironmentId.get(environmentId)
          return status?.status && (status.connectionGeneration ?? 0) > previousGeneration
        },
        { environmentId: client.environmentId, previousGeneration }
      )
    })
    .toBeTruthy()
  await expect
    .poll(() => clientStatus(client.page, paneKey), {
      timeout: 30_000,
      message: 'paired client did not apply the reconnect replay'
    })
    .toMatchObject({ state: expectedState })
  await flushNotificationDispatches(client.page)
}

async function clearClientStatus(page: Page, paneKey: string): Promise<void> {
  await page.evaluate((key) => {
    const store = window.__store
    if (!store) {
      return
    }
    const next = { ...store.getState().agentStatusByPaneKey }
    delete next[key]
    store.setState({ agentStatusByPaneKey: next })
  }, paneKey)
}

async function clearUnread(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.__store?.getState().updateWorktreeMeta(id, { isUnread: false })
  }, worktreeId)
}

test('recovers hidden remote completion and permission alerts exactly once', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(360_000)
  const screenshots = path.join(process.cwd(), 'validation-screenshots', 'sta-5244')
  mkdirSync(screenshots, { recursive: true })
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  let coldClient: PairedElectronClient | null = null
  let terminal: string | null = null
  let testError: unknown
  completedHideCycles = 0

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'STA-5244 headless host')
    const worktreeId = await expect
      .poll(
        () => client?.page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id) ?? null,
        { timeout: 60_000, message: 'paired client did not receive the host worktree' }
      )
      .not.toBeNull()
      .then(() => client!.page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id))
    if (!worktreeId) {
      throw new Error('Host worktree disappeared after pairing')
    }

    const created = await callEnvironment<{
      tab: { parentTabId: string; terminal: string | null }
    }>(client.page, client.environmentId, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      activate: false,
      select: false,
      navigation: 'caller'
    })
    terminal = created.tab.terminal
    if (!terminal) {
      throw new Error('Headless host did not create a terminal')
    }
    const surface = await expect
      .poll(() => hostSurface(host, worktreeId, created.tab.parentTabId), {
        timeout: 30_000,
        message: 'headless host did not publish the terminal surface'
      })
      .not.toBeNull()
      .then(() => hostSurface(host, worktreeId, created.tab.parentTabId))
    if (!surface) {
      throw new Error('Headless host terminal surface disappeared')
    }
    const hostPaneKey = makePaneKey(surface.parentTabId, surface.leafId)
    const clientPaneKey = makePaneKey(
      toWebTerminalSurfaceTabId(surface.parentTabId),
      surface.leafId
    )
    const endpoint = await readHookEndpoint(host.app)
    expect(Number(endpoint.port)).toBeGreaterThan(0)
    await expect
      .poll(() => hasManagedClaudeHooks(host), {
        timeout: 30_000,
        message: 'isolated host did not install every managed Claude hook'
      })
      .toBe(true)
    const clientTabId = toWebTerminalSurfaceTabId(surface.parentTabId)
    await expect
      .poll(() =>
        client!.page.evaluate(
          ({ worktreeId, tabId }) => {
            const state = window.__store?.getState()
            const tabs = state?.tabsByWorktree[worktreeId] ?? []
            return tabs.some((tab) => tab.id === tabId)
          },
          { worktreeId, tabId: clientTabId }
        )
      )
      .toBe(true)
    await client.page.evaluate(
      ({ worktreeId, tabId }) => {
        const state = window.__store?.getState()
        state?.setActiveWorktree(worktreeId)
        state?.setActiveTab(tabId)
        state?.setActiveTabType('terminal')
      },
      { worktreeId, tabId: clientTabId }
    )
    await revealPairedClientWindow(client)
    await expect
      .poll(() =>
        client!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())
      )
      .toBe(true)
    await expect
      .poll(() =>
        client!.page.evaluate(
          ({ tabId }) => {
            const state = window.__store?.getState()
            return {
              worktreeId: state?.activeWorktreeId,
              tabId: state?.activeTabId,
              leafId: state?.terminalLayoutsByTabId[tabId]?.activeLeafId
            }
          },
          { tabId: clientTabId }
        )
      )
      .toEqual({ worktreeId, tabId: clientTabId, leafId: surface.leafId })

    const completionPrompt = `STA-5244 completion ${Date.now()}`
    await postClaudeHook(endpoint, hostPaneKey, worktreeId, {
      hook_event_name: 'UserPromptSubmit',
      prompt: completionPrompt
    })
    await expect
      .poll(() => hostSurface(host, worktreeId, surface.parentTabId), {
        timeout: 30_000,
        message: 'managed host hook row did not reach the session-tab snapshot'
      })
      .toMatchObject({ agentStatus: { state: 'working', prompt: completionPrompt } })
    await expect
      .poll(() => clientStatus(client!.page, clientPaneKey), {
        timeout: 30_000,
        message: 'paired client did not mirror the managed working hook row'
      })
      .toMatchObject({ state: 'working', prompt: completionPrompt })
    await installNotificationDispatchSpy(client.app)

    await hideUntilSubscriptionsPark(client)
    await postClaudeHook(endpoint, hostPaneKey, worktreeId, {
      hook_event_name: 'Stop',
      last_assistant_message: 'STA-5244 completed while hidden'
    })
    await expect
      .poll(() => hostSurface(host, worktreeId, surface.parentTabId), {
        timeout: 30_000,
        message: 'headless host did not publish done'
      })
      .toMatchObject({ agentStatus: { state: 'done' } })
    await expect(clientStatus(client.page, clientPaneKey)).resolves.toMatchObject({
      state: 'working'
    })

    await revealAfterSubscriptionsPark(client)
    await expect
      .poll(() => clientStatus(client!.page, clientPaneKey), {
        timeout: 30_000,
        message: 'paired client did not mirror done after reveal'
      })
      .toMatchObject({ state: 'done' })
    await expect
      .poll(() => notificationDispatches(client!.app), { timeout: 30_000 })
      .toEqual([
        expect.objectContaining({
          source: 'agent-task-complete',
          agentState: 'done',
          worktreeId,
          attentionRequired: true
        })
      ])
    await expect
      .poll(() => unreadBadgeState(client!, worktreeId))
      .toMatchObject({
        unread: true,
        unreadCount: 1,
        dock: process.platform === 'darwin' ? '1' : null
      })
    await expect(
      client.page.locator(`[data-worktree-id=${JSON.stringify(worktreeId)}]`).first()
    ).toContainText('Done')
    await client.page.screenshot({ path: path.join(screenshots, '01-hidden-done-pass.png') })

    await clearUnread(client.page, worktreeId)
    await expect
      .poll(() => unreadBadgeState(client!, worktreeId))
      .toMatchObject({
        unread: false,
        unreadCount: 0,
        dock: process.platform === 'darwin' ? '' : null
      })

    const permissionPrompt = `STA-5244 permission ${Date.now()}`
    await postClaudeHook(endpoint, hostPaneKey, worktreeId, {
      hook_event_name: 'UserPromptSubmit',
      prompt: permissionPrompt
    })
    await expect
      .poll(() => clientStatus(client!.page, clientPaneKey), { timeout: 30_000 })
      .toMatchObject({ state: 'working', prompt: permissionPrompt })

    await hideUntilSubscriptionsPark(client)
    await postClaudeHook(endpoint, hostPaneKey, worktreeId, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git status' }
    })
    await expect
      .poll(() => hostSurface(host, worktreeId, surface.parentTabId), {
        timeout: 30_000,
        message: 'headless host did not publish the permission wait'
      })
      .toMatchObject({ agentStatus: { state: 'waiting', toolName: 'Bash' } })
    await expect(clientStatus(client.page, clientPaneKey)).resolves.toMatchObject({
      state: 'working'
    })

    await revealAfterSubscriptionsPark(client)
    await expect
      .poll(() => clientStatus(client!.page, clientPaneKey), {
        timeout: 30_000,
        message: 'paired client did not mirror permission wait after reveal'
      })
      .toMatchObject({ state: 'waiting' })
    await expect
      .poll(() => notificationDispatches(client!.app), { timeout: 30_000 })
      .toEqual([
        expect.objectContaining({ agentState: 'done', worktreeId }),
        expect.objectContaining({ agentState: 'waiting', worktreeId, attentionRequired: true })
      ])
    await expect
      .poll(() => unreadBadgeState(client!, worktreeId))
      .toMatchObject({
        unread: true,
        unreadCount: 1,
        dock: process.platform === 'darwin' ? '1' : null
      })
    await expect(
      client.page.locator(`[data-worktree-id=${JSON.stringify(worktreeId)}]`).first()
    ).toContainText('Needs permission')
    await client.page.screenshot({ path: path.join(screenshots, '03-hidden-permission-pass.png') })

    await hideUntilSubscriptionsPark(client)
    await postClaudeHook(endpoint, hostPaneKey, worktreeId, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git status --short' }
    })
    await expect
      .poll(() => hostSurface(host, worktreeId, surface.parentTabId))
      .toMatchObject({
        agentStatus: { state: 'waiting', toolInput: 'git status --short' }
      })
    await revealAfterSubscriptionsPark(client)
    await expect
      .poll(() => clientStatus(client!.page, clientPaneKey), {
        message: 'same-turn reveal replay did not settle'
      })
      .toMatchObject({ state: 'waiting', toolInput: 'git status --short' })
    await flushNotificationDispatches(client.page)
    expect(await notificationDispatches(client.app)).toHaveLength(2)
    await reconnectAndAwaitReplay(client, clientPaneKey, 'waiting')
    expect(await notificationDispatches(client.app)).toHaveLength(2)

    await clearUnread(client.page, worktreeId)
    await expect
      .poll(() => unreadBadgeState(client!, worktreeId))
      .toMatchObject({
        unread: false,
        unreadCount: 0,
        dock: process.platform === 'darwin' ? '' : null
      })
    coldClient = await launchPairedElectronClient(host.offer, testInfo, 'STA-5244 cold replay', {
      beforeRendererReady: installNotificationDispatchSpy
    })
    await expect
      .poll(() => clientStatus(coldClient!.page, clientPaneKey), {
        timeout: 30_000,
        message: 'cold client did not hydrate terminal permission state'
      })
      .toMatchObject({ state: 'waiting' })
    await flushNotificationDispatches(coldClient.page)
    expect(await unreadBadgeState(coldClient, worktreeId)).toMatchObject({
      unread: false,
      unreadCount: 0,
      dock: process.platform === 'darwin' ? '' : null
    })
    expect(await notificationDispatches(coldClient.app)).toHaveLength(0)
    await reconnectAndAwaitReplay(coldClient, clientPaneKey, 'waiting')
    expect(await notificationDispatches(coldClient.app)).toHaveLength(0)
    await coldClient.page.screenshot({
      path: path.join(screenshots, '02-cold-permission-silent.png')
    })
  } catch (error) {
    testError = error
  }
  const cleanupErrors: unknown[] = []
  const cleanupStages = [
    () => coldClient?.dispose() ?? Promise.resolve(),
    () =>
      terminal
        ? host.client.call('terminal.closeTab', { terminal }).then(() => undefined)
        : Promise.resolve(),
    () => client?.dispose() ?? Promise.resolve(),
    () => host.dispose()
  ]
  for (const cleanup of cleanupStages) {
    try {
      await cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (testError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([testError, ...cleanupErrors], 'STA-5244 test and cleanup failed')
  }
  if (testError !== undefined) {
    throw testError
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'STA-5244 fixture cleanup failed')
  }
})
