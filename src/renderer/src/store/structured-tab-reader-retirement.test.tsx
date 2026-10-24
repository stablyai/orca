// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { AgentSessionHistoryPage } from '../../../shared/agent-session-wire'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { createAppState } from './index'
import { getAgentStatusOwner } from './agent-status-commit'
import { removedStructuredReaders } from './structured-tab-read-retirement'
import { useStructuredAgentSessionRead } from '../components/native-chat/use-structured-agent-session-read'
import { getStructuredAgentSessionReadOwner } from '../components/native-chat/structured-agent-session-read-owner'
import {
  findStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from '../components/native-chat/structured-agent-session-read-owner-registry'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from './slices/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { isTabClosePending } from '@/runtime/layout-owner-pending-tabs'

const mocks = vi.hoisted(() => ({ main: true, refuse: false, subscribe: vi.fn() }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.main
  }
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => {
  const client = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply({
    ...(await original<typeof RuntimeRpcClient>()),
    callRuntimeRpc: <TResult,>() => new Promise<TResult>(() => {})
  })
  return {
    ...client,
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) =>
      mocks.refuse && args[1] === 'layout.apply'
        ? Promise.reject(new Error('close call failed'))
        : client.callRuntimeRpc(...args)
  }
})
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: () => Promise.resolve({ ok: true, page: history }),
  subscribeStructuredAgentSession: mocks.subscribe
}))

const target = { kind: 'local' } as const
const tab = {
  id: 'agent-session:reader-close',
  entityId: 'reader-close',
  groupId: 'g',
  worktreeId: 'wt',
  contentType: 'agent-session',
  executionHostId: 'local',
  agentSessionAgent: 'codex',
  label: 'Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
} as const
const cursor = { epoch: 'epoch-a', sequence: 1 }
const history: AgentSessionHistoryPage = {
  sessionId: tab.entityId,
  epoch: cursor.epoch,
  direction: 'tail',
  items: [],
  removedItemIds: [],
  submissions: [],
  window: { oldest: null, newest: null, nextCursor: cursor },
  liveCursor: cursor,
  hasOlder: false,
  hasNewer: false
}
function storeWithTab() {
  const store = createStore(createAppState)
  store.setState({
    activeWorktreeId: 'wt',
    activeGroupIdByWorktree: { wt: 'g' },
    unifiedTabsByWorktree: { wt: [tab] },
    groupsByWorktree: {
      wt: [{ id: 'g', worktreeId: 'wt', activeTabId: tab.id, tabOrder: [tab.id] }]
    }
  })
  return store
}

let main: TabsDrawnFromMain | undefined
beforeEach(() => {
  mocks.refuse = false
  mocks.main = true
  mocks.subscribe.mockReset().mockResolvedValue({ unsubscribe: vi.fn() })
})
afterEach(() => {
  cleanup()
  main?.close()
  main = undefined
  resetStructuredAgentSessionReadOwnersForTests()
  vi.restoreAllMocks()
})

describe('reader lifetime follows committed structured tab removal', () => {
  it('preserves duplicate host-qualified membership and resolves cached topology from each state', () => {
    const initial = storeWithTab().getState()
    const remote = { ...tab, executionHostId: 'runtime:env-1' } as const
    const previous = { ...initial, unifiedTabsByWorktree: { wt: [tab, tab, remote] } }
    const next = { ...initial, unifiedTabsByWorktree: { moved: [tab] } }
    expect(removedStructuredReaders(previous, next)).toEqual([
      { sessionId: tab.entityId, target: { kind: 'environment', environmentId: 'env-1' } }
    ])
    expect(
      removedStructuredReaders(previous, {
        ...next,
        unifiedTabsByWorktree: { moved: [tab, remote] }
      })
    ).toEqual([])

    const unstamped = { ...tab, executionHostId: undefined }
    const topology = { wt: [unstamped] }
    const empty = { ...initial, unifiedTabsByWorktree: {} }
    const state = { ...initial, unifiedTabsByWorktree: topology }
    expect(removedStructuredReaders(state, empty)[0]?.target).toEqual({ kind: 'local' })
    expect(
      removedStructuredReaders(
        { ...state, activeWorkspaceExecutionHostId: 'runtime:env-1' },
        empty
      )[0]?.target
    ).toEqual({ kind: 'environment', environmentId: 'env-1' })
  })

  it('keeps the rendered reader working after a refused main close and hide/show', async () => {
    const store = storeWithTab()
    main = await drawTabsFromMain(store)
    const view = renderHook(
      ({ visible }) =>
        useStructuredAgentSessionRead({ sessionId: tab.entityId, target, isVisible: visible }),
      { initialProps: { visible: true } }
    )
    await waitFor(() => expect(view.result.current.state.status).toBe('ready'))
    const reader = getStructuredAgentSessionReadOwner(tab.entityId, target)
    const dispose = vi.spyOn(reader, 'dispose')
    const subscriptions = mocks.subscribe.mock.calls.length
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.refuse = true
    await act(async () => {
      store.getState().closeUnifiedTab(tab.id)
      await main?.settle()
    })
    expect(store.getState().unifiedTabsByWorktree.wt).toEqual([tab])
    expect(isTabClosePending(tab.id)).toBe(false)
    expect(findStructuredAgentSessionReadOwner(tab.entityId, target)).toBe(reader)
    expect(dispose).not.toHaveBeenCalled()
    view.rerender({ visible: false })
    view.rerender({ visible: true })
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(subscriptions + 1))
    act(() =>
      mocks.subscribe.mock.calls.at(-1)?.[2]({
        type: 'snapshot',
        sessionId: tab.entityId,
        page: {
          ...history,
          items: [
            {
              itemId: 'after-refused-close',
              revision: 1,
              sequence: 2,
              observedAt: 2,
              body: { kind: 'message', role: 'assistant', blocks: [] }
            }
          ]
        }
      })
    )
    expect(view.result.current.state.items[0]?.itemId).toBe('after-refused-close')
    expect(view.result.current.state.status).toBe('ready')
  })

  it.each([false, true])(
    'retires exactly once on successful close (main=%s)',
    async (mainOwned) => {
      mocks.main = mainOwned
      const store = storeWithTab()
      main = await drawTabsFromMain(store)
      const reader = getStructuredAgentSessionReadOwner(tab.entityId, target)
      const dispose = vi.spyOn(reader, 'dispose')
      const owner = getAgentStatusOwner(store)
      expect(() =>
        owner.transact(() => {
          store.setState({ unifiedTabsByWorktree: {} })
          throw new Error('abort removal')
        })
      ).toThrow('abort removal')
      expect(findStructuredAgentSessionReadOwner(tab.entityId, target)).toBe(reader)
      const observations: unknown[] = []
      store.subscribe((state) => {
        if (!state.unifiedTabsByWorktree.wt?.some((entry) => entry.id === tab.id)) {
          observations.push([
            findStructuredAgentSessionReadOwner(tab.entityId, target),
            dispose.mock.calls.length
          ])
        }
      })
      layoutApplyTestTransport.answerWith('pending')
      store.getState().closeUnifiedTab(tab.id)
      if (mainOwned) {
        expect(isTabClosePending(tab.id)).toBe(true)
        expect(findStructuredAgentSessionReadOwner(tab.entityId, target)).toBe(reader)
        expect(dispose).not.toHaveBeenCalled()
        layoutApplyTestTransport.answerWith('apply')
        layoutApplyTestTransport.answerPending()
      }
      await main.settle()
      expect(store.getState().unifiedTabsByWorktree.wt ?? []).toEqual([])
      expect(observations[0]).toEqual([undefined, 0])
      expect(findStructuredAgentSessionReadOwner(tab.entityId, target)).toBeUndefined()
      expect(dispose).toHaveBeenCalledTimes(1)
      store.getState().closeUnifiedTab(tab.id)
      expect(dispose).toHaveBeenCalledTimes(1)
    }
  )
})
