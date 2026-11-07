import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_SESSION_TITLE_REFRESH_RUNTIME_CAPABILITY } from '../../../../../../shared/ai-vault/contracts/ai-vault-runtime-capabilities'
import { makeState, titleResult } from './ai-vault-tab-title-test-fixture'
import { startAiVaultTabTitleSync } from './ai-vault-tab-title-sync'
import { settleAiVaultTitleRequestBatches } from './ai-vault-tab-title-batches'
import { collectAiVaultTitleRequests } from './ai-vault-tab-title-requests'
import type * as MountedTerminalTabRegistry from '@/runtime/mounted-terminal-tab-registry'
import type * as TitleRequests from './ai-vault-tab-title-requests'

vi.mock('./ai-vault-tab-title-requests', async (importOriginal) => {
  const actual = await importOriginal<typeof TitleRequests>()
  return { ...actual, collectAiVaultTitleRequests: vi.fn(actual.collectAiVaultTitleRequests) }
})

vi.mock('@/runtime/mounted-terminal-tab-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof MountedTerminalTabRegistry>()),
  findRegisteredTerminalTab: () => ({
    tab: {
      getManager: () => ({
        getNumericIdForLeaf: (leafId: string) =>
          leafId === '00000000-0000-4000-8000-000000000001' ? 7 : 8
      })
    }
  })
}))
let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  vi.useRealTimers()
})
function storeFor(executionHostId: 'local' | 'runtime:server-1') {
  return makeState({
    executionHostId,
    worktreeId: 'worktree-1',
    path: '/workspace/albacore',
    aiVaultTitle: { agent: 'codex', sessionId: 'codex-session', title: 'First name' }
  })
}

describe('session title freshness', () => {
  it.each(['local', 'capable', 'legacy'] as const)(
    'refreshes a named session on a %s host',
    async (host) => {
      vi.useFakeTimers()
      const store = storeFor(host === 'local' ? 'local' : 'runtime:server-1')
      if (host === 'capable') {
        store.update({
          runtimeStatusByEnvironmentId: new Map([
            [
              'server-1',
              {
                checkedAt: 1,
                status: {
                  runtimeId: 'server-1',
                  rendererGraphEpoch: 1,
                  graphStatus: 'ready',
                  authoritativeWindowId: null,
                  liveTabCount: 1,
                  liveLeafCount: 1,
                  capabilities: [AI_VAULT_SESSION_TITLE_REFRESH_RUNTIME_CAPABILITY]
                }
              }
            ]
          ])
        })
      }
      let title = 'First name'
      stop = startAiVaultTabTitleSync({
        ...store,
        resolveSessionTitles: async () => titleResult('codex', title)
      })
      await vi.advanceTimersByTimeAsync(0)
      title = 'Renamed conversation'
      await vi.advanceTimersByTimeAsync(10_000)
      const statuses = store.getState().runtimeStatusByEnvironmentId
      if (host === 'capable') {
        store.update({
          runtimeStatusByEnvironmentId: new Map([
            ['server-1', { ...statuses.get('server-1')!, checkedAt: 2 }]
          ])
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.title).toBe(
          'First name'
        )
      }
      await vi.advanceTimersByTimeAsync(10_000)
      expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.title).toBe(
        host === 'legacy' ? 'First name' : 'Renamed conversation'
      )
      if (host === 'legacy') {
        await vi.advanceTimersByTimeAsync(130_000)
        const state = store.getState()
        const paneKey = 'tab-2:00000000-0000-4000-8000-000000000001'
        store.update({
          tabsByWorktree: {
            'worktree-1': [
              ...state.tabsByWorktree['worktree-1'],
              { ...state.tabsByWorktree['worktree-1'][0], id: 'tab-2' }
            ]
          },
          agentStatusByPaneKey: {
            ...state.agentStatusByPaneKey,
            [paneKey]: {
              ...state.agentStatusByPaneKey['tab-1:00000000-0000-4000-8000-000000000001'],
              paneKey,
              tabId: 'tab-2',
              providerSession: { key: 'session_id', id: 'other-session' }
            }
          }
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.title).toBe(
          'First name'
        )
        await vi.advanceTimersByTimeAsync(150_000)
        expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.title).toBe(
          'Renamed conversation'
        )
      }
    }
  )

  it.each(['local', 'runtime:server-1'] as const)(
    'uses only semantic owning-pane hints on %s',
    async (host) => {
      vi.useFakeTimers()
      const store = storeFor(host)
      const titles = (owner: string, sibling: string) =>
        store.update({ runtimePaneTitlesByTabId: { 'tab-1': { 7: owner, 8: sibling } } })
      titles('[ ! ] Action Required', 'Shell')
      let title = 'First name'
      stop = startAiVaultTabTitleSync({
        ...store,
        resolveSessionTitles: async () => titleResult('codex', title)
      })
      await vi.advanceTimersByTimeAsync(0)
      title = 'Renamed conversation'
      titles('[ . ] Action Required', 'Shell')
      await vi.advanceTimersByTimeAsync(0)
      expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.title).toBe(
        'First name'
      )
      titles('[ . ] Action Required', 'Building')
      await vi.advanceTimersByTimeAsync(0)
      expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.title).toBe(
        'First name'
      )
      titles('Working on the rename', 'Building')
      await vi.advanceTimersByTimeAsync(0)
      expect(store.getState().tabsByWorktree['worktree-1'][0].aiVaultTitle?.title).toBe(
        host === 'local' ? 'Renamed conversation' : 'First name'
      )
    }
  )

  it('drops a queued batch whose tab closed while the first batch ran', async () => {
    const store = storeFor('local')
    const request = collectAiVaultTitleRequests(store.getState())[0]!
    const requests = Array.from({ length: 65 }, (_, i) => ({
      ...request,
      tabId: `tab-${i}`,
      paneKey: `tab-${i}:00000000-0000-4000-8000-000000000001`
    }))
    let current = requests
    const sent: string[] = []
    await settleAiVaultTitleRequestBatches(
      requests,
      async (batch) => {
        sent.push(...batch.map((entry) => entry.tabId))
        current = requests.slice(0, 64)
      },
      () => current
    )
    expect(sent).not.toContain('tab-64')
    expect(sent).toHaveLength(64)
  })
})

describe('host-status title gating', () => {
  function runtimeStatus(capabilities: string[], checkedAt: number) {
    return new Map([
      [
        'server-1',
        {
          checkedAt,
          status: {
            runtimeId: 'server-1',
            rendererGraphEpoch: 1,
            graphStatus: 'ready' as const,
            authoritativeWindowId: null,
            liveTabCount: 1,
            liveLeafCount: 1,
            capabilities
          }
        }
      ]
    ])
  }

  it('skips the tab catalog walk when a status ping keeps title-refresh support', async () => {
    const store = storeFor('runtime:server-1')
    const resolveSessionTitles = vi.fn(async () => titleResult('codex', 'First name'))
    stop = startAiVaultTabTitleSync({ ...store, resolveSessionTitles })
    await vi.waitFor(() => expect(resolveSessionTitles).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    vi.mocked(collectAiVaultTitleRequests).mockClear()

    store.update({ runtimeStatusByEnvironmentId: runtimeStatus([], 2) })
    store.update({ runtimeStatusByEnvironmentId: runtimeStatus([], 3) })

    expect(collectAiVaultTitleRequests).not.toHaveBeenCalled()
  })

  it('reconciles when a host gains title-refresh support', async () => {
    const store = storeFor('runtime:server-1')
    const resolveSessionTitles = vi.fn(async () => titleResult('codex', 'First name'))
    const scheduleReconcile = vi.fn((callback: () => void) => {
      queueMicrotask(callback)
      return () => {}
    })
    stop = startAiVaultTabTitleSync({ ...store, resolveSessionTitles, scheduleReconcile })
    await vi.waitFor(() => expect(resolveSessionTitles).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    scheduleReconcile.mockClear()

    store.update({ runtimeStatusByEnvironmentId: runtimeStatus([], 2) })
    expect(scheduleReconcile).not.toHaveBeenCalled()
    store.update({
      runtimeStatusByEnvironmentId: runtimeStatus(
        [AI_VAULT_SESSION_TITLE_REFRESH_RUNTIME_CAPABILITY],
        3
      )
    })
    expect(scheduleReconcile).toHaveBeenCalledTimes(1)
  })
})
