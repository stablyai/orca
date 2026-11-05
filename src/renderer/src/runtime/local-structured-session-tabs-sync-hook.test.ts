// @vitest-environment happy-dom

import '../../../shared/native-chat/every-agent-chat.test-fixture'
import type * as LocalSubscription from './local-structured-session-tabs-sync/subscription'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-runtime-capabilities'
import {
  resetLocalStructuredSessionVersionForTests,
  localStructuredSessionVersionByWorktree
} from './local-structured-session-tabs-sync/inventory-generation-fence'

const mocks = vi.hoisted(() => ({
  start: vi.fn(
    async (_sync: {
      isDisposed: () => boolean
      setUnsubscribe: (stop: () => void) => void
    }): Promise<void> => undefined
  ),
  held: false,
  isWebClient: false,
  heldListeners: new Array<(held: boolean) => void>()
}))

vi.mock('./local-structured-session-tabs-sync/subscription', () => ({
  startLocalStructuredSessionTabsSync: mocks.start
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.isWebClient }))

import { useAppStore } from '../store'
import { useLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync'
import {
  resetLocalStructuredChatsForTests,
  useLocalStructuredChatsInUse
} from './local-structured-chats'

beforeEach(() => {
  mocks.start.mockReset().mockResolvedValue(undefined)
  mocks.held = false
  mocks.isWebClient = false
  mocks.heldListeners.splice(0)
  resetLocalStructuredChatsForTests()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        holdsStructuredAgentSessions: vi.fn(async () => mocks.held),
        onStructuredAgentSessionsHeldChanged: vi.fn((listener: (held: boolean) => void) => {
          mocks.heldListeners.push(listener)
          return () => undefined
        })
      }
    }
  })
  useAppStore.setState({ workspaceSessionReady: true, terminalStartupRestorationReady: true })
})

afterEach(() => {
  cleanup()
  resetLocalStructuredSessionVersionForTests()
  vi.useRealTimers()
  resetLocalStructuredChatsForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each([100, 1000])('bounds root preference work for %i choices', async (size) => {
  let reads = 0
  const choicesFor = (on: boolean): Record<string, boolean> => {
    const choices: Record<string, boolean> = {}
    for (let index = 0; index < size; index++) {
      Object.defineProperty(choices, `agent-${index}`, {
        enumerable: true,
        get: () => {
          reads++
          return on && index === size - 1
        }
      })
    }
    return choices
  }
  const choices = choicesFor(false)
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, nativeChatProviders: choices }
  })
  const renders = vi.fn()
  renderHook(() => {
    renders(useLocalStructuredChatsInUse())
    useLocalStructuredSessionTabsSync()
  })
  await act(async () => {
    await Promise.resolve()
  })
  const initialRenders = renders.mock.calls.length
  reads = 0
  act(() => useAppStore.setState({ activeRepoId: 'unrelated-repo' }))
  expect(renders).toHaveBeenCalledTimes(initialRenders)
  // Two root consumers each enumerate exactly this map; no per-chat acquisition or fanout.
  expect(reads).toBe(2 * size)
  expect(mocks.start).not.toHaveBeenCalled()
  act(() =>
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        nativeChatProviders: choicesFor(true)
      }
    })
  )
  expect(mocks.start).toHaveBeenCalledOnce()
  expect(renders).toHaveBeenLastCalledWith(true)
  const onRenders = renders.mock.calls.length
  act(() =>
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        nativeChatProviders: choicesFor(true)
      }
    })
  )
  expect(renders).toHaveBeenCalledTimes(onRenders)
  expect(mocks.start).toHaveBeenCalledOnce()
  act(() =>
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        agentDefaultSurface: 'chat',
        nativeChatProviders: choicesFor(false)
      }
    })
  )
  reads = 0
  act(() => useAppStore.setState({ activeRepoId: 'another-unrelated-repo' }))
  expect(reads).toBe(0)
  expect(renders).toHaveBeenCalledTimes(onRenders)
  expect(mocks.start).toHaveBeenCalledOnce()
})

let actualSubscription: typeof LocalSubscription
beforeAll(async () => {
  actualSubscription = await vi.importActual<typeof LocalSubscription>(
    './local-structured-session-tabs-sync/subscription'
  )
})

it('recovers failed capability and stale initial inventory with owned timers while ready and inUse stay true', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  mocks.start.mockImplementation(actualSubscription.startLocalStructuredSessionTabsSync)
  const snapshot = {
    worktree: 'repo-1::worktree-1',
    publicationEpoch: 'E2',
    snapshotVersion: 1,
    activeTabId: 'agent-session:s1',
    activeTabType: 'agent-session',
    activeGroupId: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:s1',
        sessionId: 's1',
        agent: 'codex',
        title: 'Recovered',
        isActive: true
      }
    ]
  } as const
  const getStatus = vi
    .fn()
    .mockResolvedValue({ capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
  const call = vi.fn().mockResolvedValue({ ok: true, result: { snapshots: [snapshot] } })
  getStatus.mockRejectedValueOnce(new Error('host unavailable'))
  call.mockResolvedValueOnce({
    ok: false,
    error: { message: 'sender publication E was replaced' }
  })
  let deliver!: Parameters<typeof window.api.runtime.subscribe>[1]
  const unsubscribe = vi.fn()
  let release!: (handle: Awaited<ReturnType<typeof window.api.runtime.subscribe>>) => void
  const subscribe = vi
    .fn<typeof window.api.runtime.subscribe>()
    .mockImplementation(async (_request, callback) => {
      deliver = callback
      return { unsubscribe, sendBinary: vi.fn() }
    })
  Object.assign(window.api, { runtime: { getStatus, call, subscribe } })
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, agentDefaultSurface: 'chat' }
  })
  const { result, unmount } = renderHook(() => {
    useLocalStructuredSessionTabsSync()
    return useLocalStructuredChatsInUse()
  })
  await act(async () => {
    await mocks.start.mock.results[0]!.value
  })
  expect(subscribe).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(subscribe).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(subscribe).toHaveBeenCalledOnce()
  expect(localStructuredSessionVersionByWorktree.get(snapshot.worktree)).toMatchObject({
    publicationEpoch: 'E2',
    snapshotVersion: 1
  })
  act(() =>
    deliver({
      id: 'next',
      ok: true,
      result: { type: 'updated', ...snapshot, snapshotVersion: 2 },
      _meta: { runtimeId: 'local' }
    })
  )
  expect(localStructuredSessionVersionByWorktree.get(snapshot.worktree)).toMatchObject({
    publicationEpoch: 'E2',
    snapshotVersion: 2
  })
  expect(mocks.start).toHaveBeenCalledOnce()
  expect(result.current).toBe(true)
  expect(useAppStore.getState().workspaceSessionReady).toBe(true)
  expect(useAppStore.getState().terminalStartupRestorationReady).toBe(true)
  // A late stream handle after disposal must release itself rather than reinstall the owner.
  subscribe.mockImplementationOnce((_request, callback) => {
    deliver = callback
    return new Promise((resolve) => {
      release = resolve
    })
  })
  act(() =>
    deliver({ id: 'end', ok: true, result: { type: 'end' }, _meta: { runtimeId: 'local' } })
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(subscribe).toHaveBeenCalledTimes(2)
  const lateUnsubscribe = vi.fn()
  unmount()
  await act(async () => {
    release({ unsubscribe: lateUnsubscribe, sendBinary: vi.fn() })
  })
  expect(lateUnsubscribe).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(5000)
  expect(subscribe).toHaveBeenCalledTimes(2)
})

it('drops a pending startup retry when its generation becomes obsolete', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  mocks.start.mockImplementation(actualSubscription.startLocalStructuredSessionTabsSync)
  const getStatus = vi.fn().mockRejectedValue(new Error('host unavailable'))
  const subscribe = vi.fn()
  Object.assign(window.api, { runtime: { getStatus, subscribe } })
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, agentDefaultSurface: 'chat' }
  })
  renderHook(() => useLocalStructuredSessionTabsSync())
  await act(async () => {
    await mocks.start.mock.results[0]!.value
  })
  resetLocalStructuredSessionVersionForTests()
  await vi.advanceTimersByTimeAsync(5000)
  expect(getStatus).toHaveBeenCalledOnce()
  expect(subscribe).not.toHaveBeenCalled()
})
