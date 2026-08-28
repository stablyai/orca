import { expect, test } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'

type Dispatch = { source?: string; paneKey?: string }

async function callRuntime<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  const response = await page.evaluate(
    async ({ environmentId, method, params }) =>
      window.api.runtimeEnvironments.call({ selector: environmentId, method, params }),
    { environmentId, method, params }
  )
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
  return response.result as TResult
}

async function installDispatchSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & {
      __sta5244Dispatches?: Dispatch[]
    }
    state.__sta5244Dispatches = []
    ipcMain.removeHandler('notifications:dispatch')
    ipcMain.handle('notifications:dispatch', (_event, payload: Dispatch) => {
      state.__sta5244Dispatches?.push(payload)
      return { delivered: true }
    })
  })
}

async function dispatches(app: ElectronApplication): Promise<Dispatch[]> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __sta5244Dispatches?: Dispatch[] }
    return state.__sta5244Dispatches ?? []
  })
}

async function isUnread(page: Page, worktreeId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const worktree = window.__store
      ?.getState()
      .allWorktrees()
      .find((candidate) => candidate.id === id)
    return worktree?.isUnread === true
  }, worktreeId)
}

test('STA-5244 new/new paired headed client receives one hidden completion and permission alert', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    await host.client.call('repo.update', {
      repo: `id:${added.result.repo.id}`,
      updates: { externalWorktreeVisibility: 'show' }
    })
    const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
      repo: `id:${added.result.repo.id}`
    })
    const worktreeId = listed.result.worktrees[0]?.id
    if (!worktreeId) {
      throw new Error('headless host did not publish a worktree')
    }

    client = await launchPairedElectronClient(host.offer, testInfo, 'STA-5244 headless host')
    await installDispatchSpy(client.app)
    await expect
      .poll(
        () =>
          client!.page.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((w) => w.id === id),
            worktreeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    await client.page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)

    const created = await callRuntime<{
      tab: { parentTabId: string; leafId: string; terminal: string | null }
    }>(client.page, client.environmentId, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      command: 'sleep 120',
      launchAgent: 'codex',
      activate: true,
      select: true,
      navigation: 'caller'
    })
    if (!created.tab.terminal) {
      throw new Error('headless host did not create the managed agent terminal')
    }
    const paneKey = `${created.tab.parentTabId}:${created.tab.leafId}`
    await expect
      .poll(
        async () => {
          const result = await callRuntime<{ terminals: { handle: string; connected: boolean }[] }>(
            client!.page,
            client!.environmentId,
            'terminal.list',
            { worktree: `id:${worktreeId}` }
          )
          return result.terminals.some(
            (terminal) => terminal.handle === created.tab.terminal && terminal.connected
          )
        },
        { timeout: 30_000, message: 'managed agent terminal never became connected' }
      )
      .toBe(true)
    const endpoint = await readHookEndpoint(host.app)
    await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
    await expect.poll(() => client!.page.evaluate(() => document.visibilityState)).toBe('visible')

    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'working',
      prompt: 'sta5244 deterministic turn'
    })
    await expect
      .poll(
        async () => {
          const snapshot = await host.client.call<{
            tabs: { id: string; agentStatus?: { paneKey?: string; state?: string } }[]
          }>('session.tabs.list', { worktree: `id:${worktreeId}` })
          return snapshot.result.tabs.some(
            (tab) =>
              tab.id === `${created.tab.parentTabId}::${created.tab.leafId}` &&
              tab.agentStatus?.paneKey === paneKey
          )
        },
        { timeout: 30_000, message: 'managed agent hook row never reached host inventory' }
      )
      .toBe(true)
    await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide())
    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'done',
      prompt: 'sta5244 deterministic turn',
      lastAssistantMessage: 'done while hidden'
    })
    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'done',
      prompt: 'sta5244 deterministic turn',
      lastAssistantMessage: 'done while hidden'
    })

    await expect.poll(() => isUnread(client!.page, worktreeId), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => dispatches(client!.app), { timeout: 30_000 }).toHaveLength(1)
    await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
    await expect.poll(() => dispatches(client!.app), { timeout: 10_000 }).toHaveLength(1)

    await client.page.evaluate(
      (id) => window.__store?.getState().clearWorktreeUnread(id),
      worktreeId
    )
    await installDispatchSpy(client.app)
    await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide())

    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'working',
      prompt: 'sta5244 permission turn'
    })
    await expect
      .poll(
        async () => {
          const snapshot = await host.client.call<{
            tabs: { id: string; agentStatus?: { paneKey?: string; state?: string } }[]
          }>('session.tabs.list', { worktree: `id:${worktreeId}` })
          return snapshot.result.tabs.some(
            (tab) =>
              tab.id === `${created.tab.parentTabId}::${created.tab.leafId}` &&
              tab.agentStatus?.paneKey === paneKey &&
              tab.agentStatus.state === 'working'
          )
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    await client.page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.disconnect({ selector })
      window.__store?.getState().setRuntimeEnvironmentStatus(selector, {
        status: null,
        checkedAt: Date.now()
      })
    }, client.environmentId)
    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'waiting'
    })
    await client.page.evaluate(async (selector) => {
      const response = await window.api.runtimeEnvironments.connect({ selector })
      if (!response.ok) {
        throw new Error(`runtime reconnect failed: ${response.error.message}`)
      }
      window.__store?.getState().setRuntimeEnvironmentStatus(selector, {
        status: response.result,
        checkedAt: Date.now()
      })
    }, client.environmentId)
    await expect
      .poll(
        () =>
          client!.page.evaluate(
            (id) =>
              window.__store?.getState().runtimeStatusByEnvironmentId.get(id)?.status?.graphStatus,
            client!.environmentId
          ),
        { timeout: 30_000, message: 'paired runtime did not become graph-ready after reconnect' }
      )
      .toBe('ready')
    await expect.poll(() => isUnread(client!.page, worktreeId), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => dispatches(client!.app), { timeout: 10_000 }).toHaveLength(1)

    await client.page.evaluate(
      (id) => window.__store?.getState().clearWorktreeUnread(id),
      worktreeId
    )
    await installDispatchSpy(client.app)
    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'working',
      prompt: 'sta5244 post-reconnect turn'
    })
    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'waiting'
    })
    await expect.poll(() => isUnread(client!.page, worktreeId), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => dispatches(client!.app), { timeout: 30_000 }).toHaveLength(1)

    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'waiting'
    })
    await expect.poll(() => dispatches(client!.app), { timeout: 10_000 }).toHaveLength(1)
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
