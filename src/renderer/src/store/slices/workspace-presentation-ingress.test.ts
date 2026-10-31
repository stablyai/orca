import type * as RuntimeRpcClient from '../../runtime/runtime-rpc-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../index'
import { seed, assertU, frame, O, D, C1, C2, split } from './workspace-presentation-test-fixture'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { rawWorkspaceState, workspaceSourceWrite } from '../workspace-composition'
import { applyStructuredSessionTabSnapshots } from '../../runtime/local-structured-session-tabs-sync/snapshot-apply'
import {
  resetLocalStructuredSessionVersionForTests,
  localStructuredSessionEpochHistoryByWorktree
} from '../../runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { scheduleRetiredEpochRepair } from '../../runtime/local-structured-session-tabs-sync/retired-epoch-repair'
import { refreshLocalStructuredSessionTabs } from '../../runtime/local-structured-session-tabs-sync/inventory-refresh'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { refreshWebRuntimeSessionTabsSnapshot } from '../../runtime/web-runtime-session-snapshot'
import { buildWorkspaceSessionPayload } from '../../lib/workspace-session'
import { buildHydratedTabState } from './tabs-hydration'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../runtime/runtime-rpc-client', async (load) => ({
  ...(await load<typeof RuntimeRpcClient>()),
  callRuntimeRpc: vi.fn()
}))
vi.mock('../../runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: vi.fn().mockResolvedValue(undefined)
}))
createStoreSessionMockApi()
beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
  resetLocalStructuredSessionVersionForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('production source ingress and settlement', () => {
  it('restores failed close through actual close dispatch and ordered host reread, retaining U', async () => {
    const store = seed()
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    const list = frame(O, 'chat1', 200)
    applyStructuredSessionTabSnapshots([list])
    vi.mocked(callRuntimeRpc)
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValue(list)
    store.getState().closeUnifiedTab(C1)
    expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
    await vi.waitFor(() => {
      expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.list', {
        worktree: `id:${O}`
      })
      expect(store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)).toMatchObject({
        groupId: 'left',
        customLabel: 'Saved name'
      })
    })
    expect(store.getState().layoutByWorktree[D]).toEqual(split)
    expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O][0].worktreeId).toBe(O)
  })

  it('repairs a retired empty source through production census dispatch, parks on failure and accepts a legitimate later wake; generation teardown cancels repairs', async () => {
    vi.useFakeTimers()
    const store = seed()
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    applyStructuredSessionTabSnapshots([frame(O, 'chat1', 200)])
    applyStructuredSessionTabSnapshots([
      { ...frame(O, 'chat1', 1, false), publicationEpoch: 'headless' }
    ])
    const returning = { ...frame(O, 'chat1', 201), publicationEpoch: `epoch:${O}` }
    const census = vi
      .fn()
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValue({ ok: true, result: { snapshots: [returning], authoritative: true } })
    vi.stubGlobal('window', { api: { runtime: { call: census } } })
    const schedule = (worktree: string, epoch: string) =>
      scheduleRetiredEpochRepair(worktree, epoch, (generation) =>
        refreshLocalStructuredSessionTabs(generation, { authoritative: true })
      )
    applyStructuredSessionTabSnapshots([returning], undefined, { onRetiredEpochDrop: schedule })
    expect(localStructuredSessionEpochHistoryByWorktree.get(O)?.retired).toContain(`epoch:${O}`)
    await vi.advanceTimersByTimeAsync(250)
    expect(census).toHaveBeenCalledTimes(1)
    expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
    // A new publisher event, rather than elapsed retry decay, wakes the parked lane.
    applyStructuredSessionTabSnapshots([returning], undefined, { onRetiredEpochDrop: schedule })
    await vi.advanceTimersByTimeAsync(500)
    expect(census).toHaveBeenCalledTimes(2)
    expect(store.getState().unifiedTabsByWorktree[D].some((tab) => tab.id === C1)).toBe(true)
    schedule(O, 'retired')
    resetLocalStructuredSessionVersionForTests()
    await vi.advanceTimersByTimeAsync(5000)
    expect(census).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('admits old-shaped paired direct replies before census, persists real source routes offline, and closes immediately in both source orders', async () => {
    for (const closeBeforeDestination of [false, true]) {
      const host = closeBeforeDestination ? 'runtime:paired-before' : 'runtime:paired-after'
      const environmentId = host.slice('runtime:'.length)
      const store = seed(host)
      vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
      const answers = new Map([
        [O, frame(O, 'chat1', 200)],
        [D, frame(D, 'chat2', 3)]
      ])
      const call = vi.fn(async (args: { method: string; params?: { worktree?: string } }) => {
        expect(args.method).toBe('session.tabs.list')
        return { ok: true, result: answers.get(args.params?.worktree?.slice(3) ?? '') }
      })
      vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, O, { errorMode: 'throw' })
      if (!closeBeforeDestination) {
        await refreshWebRuntimeSessionTabsSnapshot(environmentId, D, { errorMode: 'throw' })
      }
      assertU(store)
      const payload = buildWorkspaceSessionPayload(store.getState())
      const offline = createTestStore()
      offline.setState(
        workspaceSourceWrite({
          ...buildHydratedTabState(payload, new Set([O, D])),
          workspacePresentations: { ...store.getState().workspacePresentations }
        })
      )
      assertU(offline)
      answers.set(O, frame(O, 'chat1', 201, false))
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, O, { errorMode: 'throw' })
      expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
      if (closeBeforeDestination) {
        await refreshWebRuntimeSessionTabsSnapshot(environmentId, D, { errorMode: 'throw' })
      }
      expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
      expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O] ?? []).toEqual([])
      expect(call.mock.calls.every(([args]) => args.method === 'session.tabs.list')).toBe(true)
    }
  })
})
