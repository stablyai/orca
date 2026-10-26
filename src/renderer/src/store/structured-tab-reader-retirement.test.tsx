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

const mocks = vi.hoisted(() => ({ main: true, refuse: false, subscribe: vi.fn(), call: vi.fn() }))
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
  callStructuredAgentSession: mocks.call,
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
  mocks.call.mockReset().mockResolvedValue({ ok: true, page: history })
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

it.each([false, true])(
  'round2: same-stack retained pane stays live (visibility replay %s)',
  async (replay) => {
    const React = await import('react')
    const { render } = await import('@testing-library/react')
    const store = storeWithTab()
    let visible = true
    let observed: ReturnType<typeof useStructuredAgentSessionRead> | undefined
    const Pane = React.memo(function Pane({ visible }: { visible: boolean }) {
      observed = useStructuredAgentSessionRead({
        sessionId: tab.entityId,
        target,
        isVisible: visible
      })
      return null
    })
    function Surface() {
      const state = React.useSyncExternalStore(store.subscribe, store.getState, store.getState)
      return state.unifiedTabsByWorktree.wt?.some((candidate) => candidate.id === tab.id)
        ? React.createElement(Pane, { key: tab.id, visible })
        : null
    }
    const view = render(React.createElement(Surface))
    await waitFor(() => expect(observed?.state.status).toBe('ready'))
    const old = getStructuredAgentSessionReadOwner(tab.entityId, target)
    const dispose = vi.spyOn(old, 'dispose')
    const attention = vi.fn()
    const { subscribeStructuredAttentionViews } =
      await import('@/attention/agent-subject-read-actions')
    const stopAttention = subscribeStructuredAttentionViews(attention)
    const calls = mocks.subscribe.mock.calls.length
    act(() => {
      store.setState({ unifiedTabsByWorktree: {} })
      store.setState({ unifiedTabsByWorktree: { wt: [tab] } })
    })
    expect(store.getState().unifiedTabsByWorktree.wt).toEqual([tab])
    expect(dispose).toHaveBeenCalledTimes(1)
    if (replay) {
      visible = false
      view.rerender(React.createElement(Surface))
      visible = true
      view.rerender(React.createElement(Surface))
    }
    const fresh = getStructuredAgentSessionReadOwner(tab.entityId, target)
    expect(fresh).not.toBe(old)
    act(() =>
      fresh.publishCreated({
        ...history,
        items: [
          {
            itemId: 'reopened-reply',
            revision: 1,
            sequence: 2,
            observedAt: 2,
            body: { kind: 'message', role: 'assistant', blocks: [] }
          }
        ]
      })
    )
    console.log(
      'ROUND2_SAME_STACK_REOPEN',
      JSON.stringify({
        oldRetired: old.lifetime.retired,
        oldDisposals: dispose.mock.calls.length,
        subscribeBefore: calls,
        subscribeAfter: mocks.subscribe.mock.calls.length,
        freshItems: fresh.getSnapshot().state.items.map((item) => item.itemId),
        renderedItems: observed?.state.items.map((item) => item.itemId)
      })
    )
    expect(observed?.state.items.map((item) => item.itemId)).toContain('reopened-reply')
    expect(observed?.loadOlder).toBe(fresh.loadOlder)
    expect(await observed?.loadOlder()).toBe('exhausted')
    await waitFor(() => expect(mocks.subscribe.mock.calls.length).toBeGreaterThan(calls))
    expect(attention).toHaveBeenCalledWith(expect.objectContaining({ sessionId: tab.entityId }))
    const before = observed?.state
    act(() => old.publishCreated({ ...history, items: [] }))
    expect(observed?.state).toBe(before)
    expect(old.lifetime.retired).toBe(true)
    expect(await old.loadOlder()).toBe('superseded')
    act(() =>
      mocks.subscribe.mock.calls.at(-1)?.[2]({
        type: 'snapshot',
        sessionId: tab.entityId,
        page: {
          ...history,
          items: [
            {
              itemId: 'q-live',
              revision: 1,
              sequence: 3,
              observedAt: 3,
              body: { kind: 'message', role: 'assistant', blocks: [] }
            }
          ]
        }
      })
    )
    expect(observed?.state.items.map((item) => item.itemId)).toContain('q-live')
    stopAttention()
    view.unmount()
    expect(findStructuredAgentSessionReadOwner(tab.entityId, target)).toBeUndefined()
  }
)

it('does not acquire during abandoned render and genuine committed close', async () => {
  const React = await import('react')
  const { render } = await import('@testing-library/react')
  const store = storeWithTab()
  let beforeCommit: ReturnType<typeof useStructuredAgentSessionRead> | undefined
  function Pending(): never {
    beforeCommit = useStructuredAgentSessionRead({ sessionId: 'abandoned', target })
    throw new Promise(() => {})
  }
  const pending = render(
    React.createElement(React.Suspense, { fallback: null }, React.createElement(Pending))
  )
  expect(findStructuredAgentSessionReadOwner('abandoned', target)).toBeUndefined()
  expect(await beforeCommit?.loadOlder()).toBe('superseded')
  expect(mocks.subscribe).not.toHaveBeenCalled()
  pending.unmount()
  const Pane = React.memo(function Pane() {
    useStructuredAgentSessionRead({ sessionId: tab.entityId, target })
    return null
  })
  function Surface() {
    const state = React.useSyncExternalStore(store.subscribe, store.getState, store.getState)
    return state.unifiedTabsByWorktree.wt?.length ? React.createElement(Pane) : null
  }
  const view = render(React.createElement(Surface))
  await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
  act(() => store.setState({ unifiedTabsByWorktree: {} }))
  await act(async () => {})
  expect(findStructuredAgentSessionReadOwner(tab.entityId, target)).toBeUndefined()
  expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  view.unmount()
})

it.each([10, 100])(
  'keeps terminal notification and ownership work local among %s keys',
  async (count) => {
    const { retireStructuredAgentSessionReadOwner } =
      await import('../components/native-chat/structured-agent-session-read-owner')
    const owners = Array.from({ length: count }, (_, i) =>
      getStructuredAgentSessionReadOwner(`key-${i}`, target)
    )
    const visits = owners.map(() => vi.fn())
    const releases = owners.map((owner, i) => owner.subscribe(visits[i]))
    const closes = owners.map((owner) => vi.spyOn(owner, 'dispose'))
    const snapshots = owners.map((owner) => vi.spyOn(owner, 'getSnapshot'))
    const view = renderHook(() => [
      useStructuredAgentSessionRead({ sessionId: 'key-0', target }),
      useStructuredAgentSessionRead({ sessionId: 'key-0', target })
    ])
    await waitFor(() => expect(view.result.current[0].state.status).toBe('ready'))
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    visits.forEach((visit) => visit.mockClear())
    snapshots.forEach((snapshot) => snapshot.mockClear())
    act(() => retireStructuredAgentSessionReadOwner('key-0', target))
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2))
    expect(view.result.current[0].loadOlder).not.toBe(owners[0].loadOlder)
    expect(view.result.current[0].loadOlder).toBe(view.result.current[1].loadOlder)
    expect(snapshots.slice(1).map((snapshot) => snapshot.mock.calls.length)).toEqual(
      Array(count - 1).fill(0)
    )
    expect(snapshots[0].mock.calls.length).toBeLessThan(30)
    expect(visits.map((visit) => visit.mock.calls.length)).toEqual([1, ...Array(count - 1).fill(0)])
    expect(closes.map((close) => close.mock.calls.length)).toEqual([1, ...Array(count - 1).fill(0)])
    const q = findStructuredAgentSessionReadOwner('key-0', target)
    expect(q).toBeDefined()
    expect(q).not.toBe(owners[0])
    for (let i = 1; i < count; i++) {
      expect(findStructuredAgentSessionReadOwner(`key-${i}`, target)).toBe(owners[i])
    }
    releases.forEach((release) => release())
    view.unmount()
    expect(findStructuredAgentSessionReadOwner('key-0', target)).toBeUndefined()
  }
)

describe('key-resolved committed consumer binding', () => {
  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionReadOwnersForTests()
    vi.restoreAllMocks()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.call.mockResolvedValue({ ok: true, page: history })
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
  })

  it('keeps hidden StrictMode consumers coherent through equal-empty replacement and host/key changes', async () => {
    const React = await import('react')
    const {
      getStructuredAgentSessionReadOwner,
      retireStructuredAgentSessionReadOwner,
      findStructuredAgentSessionReadOwner
    } = await import('../components/native-chat/structured-agent-session-read-owner')
    const registry =
      await import('../components/native-chat/structured-agent-session-read-owner-registry')
    const acquire = vi.spyOn(registry, 'getOrCreateStructuredReadOwner')
    const remote = { kind: 'environment', environmentId: 'twin' } as const
    const twin = getStructuredAgentSessionReadOwner('binding', remote)
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.StrictMode, null, children)
    const initialProps: {
      visible: boolean
      sessionId: string
      target: typeof target | typeof remote
    } = { visible: false, sessionId: 'binding', target: target }
    const view = renderHook(
      ({ visible, sessionId, target }) => [
        useStructuredAgentSessionRead({ sessionId, target, isVisible: visible }),
        useStructuredAgentSessionRead({ sessionId, target, isVisible: visible })
      ],
      {
        wrapper,
        initialProps
      }
    )
    const old = getStructuredAgentSessionReadOwner('binding', target)
    expect(
      acquire.mock.results
        .filter((_, i) => acquire.mock.calls[i][0] === 'local:binding')
        .every((result) => result.value === old)
    ).toBe(true)
    expect(mocks.subscribe).not.toHaveBeenCalled()
    const firstState = view.result.current[0].state
    act(() => retireStructuredAgentSessionReadOwner('binding', target))
    const fresh = getStructuredAgentSessionReadOwner('binding', target)
    expect(fresh).not.toBe(old)
    expect(view.result.current[0].state).toBe(firstState)
    expect(view.result.current[0].loadOlder).toBe(fresh.loadOlder)
    expect(view.result.current[1].loadOlder).toBe(fresh.loadOlder)
    expect(findStructuredAgentSessionReadOwner('binding', remote)).toBe(twin)
    const qTail = {
      ...history,
      direction: 'tail' as const,
      items: [
        {
          itemId: 'q-tail',
          revision: 1,
          sequence: 2,
          observedAt: 2,
          body: {
            kind: 'message' as const,
            role: 'assistant' as const,
            blocks: [{ type: 'text' as const, text: 'q-tail' }]
          }
        }
      ],
      window: {
        oldest: { epoch: history.epoch, sequence: 2 },
        newest: { epoch: history.epoch, sequence: 2 },
        nextCursor: { epoch: history.epoch, sequence: 2 }
      },
      hasOlder: true,
      hasNewer: false
    }
    act(() => fresh.publishCreated(qTail))
    mocks.call.mockImplementation((_target, method, params) =>
      Promise.resolve(
        method === 'agentSession.history' && params.direction === 'before'
          ? {
              ok: true,
              page: {
                ...history,
                direction: 'before' as const,
                items: [
                  {
                    itemId: 'q-older',
                    revision: 1,
                    sequence: 1,
                    observedAt: 1,
                    body: {
                      kind: 'message' as const,
                      role: 'assistant' as const,
                      blocks: [{ type: 'text' as const, text: 'q-older' }]
                    }
                  }
                ],
                window: {
                  oldest: { epoch: history.epoch, sequence: 1 },
                  newest: { epoch: history.epoch, sequence: 1 },
                  nextCursor: { epoch: history.epoch, sequence: 1 }
                },
                hasOlder: false,
                hasNewer: true
              }
            }
          : { ok: true, requests: [] }
      )
    )
    view.rerender({ visible: true, sessionId: 'binding', target: target })
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
    await act(async () => expect(await view.result.current[0].loadOlder()).toBe('applied'))
    expect(view.result.current[1].state.items.map((item) => item.itemId)).toEqual([
      'q-older',
      'q-tail'
    ])
    expect(await old.loadOlder()).toBe('superseded')
    view.rerender({ visible: false, sessionId: 'binding', target: target })
    expect(findStructuredAgentSessionReadOwner('binding', target)).toBe(fresh)
    expect(fresh.lifetime.retired).toBe(false)
    view.rerender({ visible: true, sessionId: 'other', target: remote })
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2))
    expect(findStructuredAgentSessionReadOwner('binding', target)).toBeUndefined()
    view.unmount()
    expect(findStructuredAgentSessionReadOwner('other', remote)).toBeUndefined()
    expect(findStructuredAgentSessionReadOwner('binding', remote)).toBe(twin)
  })

  it('reconciles canonical ownership between render and subscription and refuses displaced idle activity', async () => {
    const React = await import('react')
    const {
      getStructuredAgentSessionReadOwner,
      findStructuredAgentSessionReadOwner,
      retireStructuredAgentSessionReadOwner
    } = await import('../components/native-chat/structured-agent-session-read-owner')
    const old = getStructuredAgentSessionReadOwner('race', target)
    const release = old.subscribe(() => {})
    let fresh = old
    const view = renderHook(() => {
      React.useLayoutEffect(() => {
        release()
        fresh = getStructuredAgentSessionReadOwner('race', target)
      }, [])
      return useStructuredAgentSessionRead({
        sessionId: 'race',
        target: target,
        isVisible: false
      })
    })
    expect(fresh).not.toBe(old)
    expect(view.result.current.loadOlder).toBe(fresh.loadOlder)
    const staleListener = vi.fn()
    const stopListen = old.subscribe(staleListener)
    const stop = old.activate()
    expect(mocks.subscribe).not.toHaveBeenCalled()
    old.publishCreated({
      ...history,
      direction: 'tail' as const,
      items: [
        {
          itemId: 'old-only',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: {
            kind: 'message' as const,
            role: 'assistant' as const,
            blocks: [{ type: 'text' as const, text: 'old-only' }]
          }
        }
      ],
      window: {
        oldest: { epoch: history.epoch, sequence: 1 },
        newest: { epoch: history.epoch, sequence: 1 },
        nextCursor: { epoch: history.epoch, sequence: 1 }
      },
      hasOlder: false,
      hasNewer: false
    })
    expect(staleListener).not.toHaveBeenCalled()
    expect(findStructuredAgentSessionReadOwner('race', target)).toBe(fresh)
    stopListen()
    stop()
    view.unmount()
    const r = getStructuredAgentSessionReadOwner('late', target)
    const late = renderHook(() => {
      React.useLayoutEffect(() => retireStructuredAgentSessionReadOwner('late', target), [])
      return useStructuredAgentSessionRead({
        sessionId: 'late',
        target: target,
        isVisible: false
      })
    })
    const q = findStructuredAgentSessionReadOwner('late', target)
    expect(q).toBeDefined()
    expect(q).not.toBe(r)
    expect(late.result.current.loadOlder).toBe(q?.loadOlder)
    late.unmount()
  })

  it('notifies surviving consumers despite throwing teardown/listener and preserves reset callback successors', async () => {
    const {
      getStructuredAgentSessionReadOwner,
      findStructuredAgentSessionReadOwner,
      retireStructuredAgentSessionReadOwner
    } = await import('../components/native-chat/structured-agent-session-read-owner')
    const r = getStructuredAgentSessionReadOwner('throws', target)
    const last = vi.fn()
    const teardown = vi.fn(() => {
      throw new Error('transport teardown')
    })
    mocks.subscribe.mockResolvedValue({ unsubscribe: teardown })
    const release = r.activate()
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled())
    await act(async () => {})
    r.subscribe(() => {
      throw new Error('first listener')
    })
    r.subscribe(last)
    const view = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'throws', target: target, isVisible: false })
    )
    last.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    act(() => retireStructuredAgentSessionReadOwner('throws', target))
    expect(last).toHaveBeenCalledTimes(1)
    expect(teardown).toHaveBeenCalledTimes(1)
    const q = getStructuredAgentSessionReadOwner('throws', target)
    expect(q).not.toBe(r)
    expect(view.result.current.loadOlder).toBe(q.loadOlder)
    const keepQ = q.subscribe(() => {})
    view.unmount()
    expect(() => release()).not.toThrow()
    expect(() => r.dispose()).not.toThrow()
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(findStructuredAgentSessionReadOwner('throws', target)).toBe(q)
    const other = getStructuredAgentSessionReadOwner('reset-other', target)
    let successor = q
    q.subscribe(() => {
      expect(other.lifetime.retired).toBe(true)
      successor = getStructuredAgentSessionReadOwner('throws', target)
    })
    resetStructuredAgentSessionReadOwnersForTests()
    expect(successor).not.toBe(q)
    expect(successor.lifetime.retired).toBe(false)
    expect(findStructuredAgentSessionReadOwner('throws', target)).toBe(successor)
    keepQ()
  })
})
