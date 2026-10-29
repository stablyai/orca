// #24932: terminal-agent completion/input pushes come from a windowless host, or once from the desktop window.
import { randomUUID } from 'node:crypto'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { postClaudeHook, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { createDesktopMobilePairingOffer } from './helpers/paired-electron-client'
import { pairMobileClient, type PairedMobileClient } from './helpers/paired-mobile-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'

type PhoneAlert = { source: string; agentState?: string; worktreeId?: string; title: string }

/** Every notification the host offers this phone, desktop-suppressed ones included. */
async function collectPhoneAlerts(
  phone: PairedMobileClient,
  streamErrors: string[]
): Promise<PhoneAlert[]> {
  const alerts: PhoneAlert[] = []
  let ready = false
  await phone.subscribe<{ type: string } & PhoneAlert>(
    'notifications.subscribe',
    { includeDesktopSuppressed: true },
    {
      onResponse: (response) => {
        if (response.ok && response.result.type === 'ready') {
          ready = true
        } else if (response.ok && response.result.type === 'notification') {
          alerts.push(response.result)
        }
      },
      onError: (error) => streamErrors.push(error.message)
    }
  )
  await expect.poll(() => ready).toBe(true)
  return alerts
}

const agentAlerts = (alerts: PhoneAlert[]): string[] =>
  alerts.filter((alert) => alert.source === 'agent-task-complete').map((a) => a.agentState ?? '')

type WindowDispatchRecorder = typeof globalThis & {
  __orcaE2eWindowDispatches?: { source?: string }[]
}

/** Records each agent request the window sends main, then hands it to the real handler. */
async function recordWindowDispatches(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron keeps invoke handlers in this private map; the throw below covers its absence.
    const registry = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })
      ._invokeHandlers
    const productionHandler = registry?.get('notifications:dispatch')
    if (!productionHandler) {
      throw new Error('notifications:dispatch handler was not registered in the main process')
    }
    const recorded: { source?: string }[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test-only slot on the main process global, read back below.
    ;(globalThis as WindowDispatchRecorder).__orcaE2eWindowDispatches = recorded
    ipcMain.removeHandler('notifications:dispatch')
    ipcMain.handle('notifications:dispatch', (event, request: { source?: string }, ...rest) => {
      recorded.push(request)
      return productionHandler(event, request, ...rest)
    })
  })
}

/** How many agent requests (finish or needs input) the window has sent main. */
async function windowAgentDispatchCount(electronApp: ElectronApplication): Promise<number> {
  return electronApp.evaluate(
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slot recordWindowDispatches set.
      ((globalThis as WindowDispatchRecorder).__orcaE2eWindowDispatches ?? []).filter(
        (request) => request.source === 'agent-task-complete'
      ).length
  )
}

test('a host with no window pushes its phone when a terminal agent finishes or needs input', async ({
  testRepoPath
}) => {
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost({ pairingScope: 'mobile' })
  const phone = pairMobileClient(host.offer)
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
      'worktree.ps',
      { limit: 1_000 }
    )
    const worktreeId = worktrees.find((row) => row.path === testRepoPath)?.worktreeId ?? ''
    expect(worktreeId, 'the phone lists the serve host workspace').not.toBe('')
    const endpoint = await readHookEndpoint(host.app)
    const pane = { paneKey: `tab-push:${randomUUID()}`, worktreeId }
    const streamErrors: string[] = []
    const alerts = await collectPhoneAlerts(phone, streamErrors)

    // A clear settles the pane without finishing a turn: no alert, as the window sends none.
    await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: '/clear' })
    await postClaudeHook(endpoint, pane, { hook_event_name: 'SessionStart', source: 'clear' })
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(agentAlerts(alerts)).toEqual([])

    await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await postClaudeHook(endpoint, pane, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
    await expect.poll(() => agentAlerts(alerts)).toEqual(['done'])

    await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: 'more' })
    await postClaudeHook(endpoint, pane, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    await expect.poll(() => agentAlerts(alerts)).toEqual(['done', 'waiting'])

    expect(streamErrors).toEqual([])
  } finally {
    phone.dispose()
    await host.dispose()
  }
})

test('a desktop with a window pushes its phone once, from the window, for a terminal agent’s finish', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const endpoint = await readHookEndpoint(electronApp)
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  await recordWindowDispatches(electronApp)
  const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
  try {
    const streamErrors: string[] = []
    const alerts = await collectPhoneAlerts(phone, streamErrors)
    await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await postClaudeHook(endpoint, pane, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
    await expect.poll(() => windowAgentDispatchCount(electronApp)).toBe(1)
    await expect.poll(() => agentAlerts(alerts)).toEqual(['done'])
    // Past the 1.5 s quiet window main would have waited, had it pushed too.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(agentAlerts(alerts)).toEqual(['done'])
    expect(streamErrors).toEqual([])
  } finally {
    phone.dispose()
  }
})
