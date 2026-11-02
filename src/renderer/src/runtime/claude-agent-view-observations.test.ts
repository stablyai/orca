import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcSubscriptionHandlers } from './runtime-rpc-subscribe'

const subscribe = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: subscribe }))

import { readClaudeAgentViews, subscribeClaudeAgentViews } from './claude-agent-view-observations'

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('shares one host stream and clears its observed view when disconnected until fresh evidence arrives', async () => {
  vi.useFakeTimers()
  const streams: RuntimeRpcSubscriptionHandlers[] = []
  const close = vi.fn()
  subscribe.mockImplementation(async (_target, _method, _params, handlers) => {
    streams.push(handlers)
    return { unsubscribe: close }
  })
  const key = 'reconnecting-host'
  const first = subscribeClaudeAgentViews(
    key,
    { kind: 'environment', environmentId: 'env' },
    vi.fn()
  )
  const second = subscribeClaudeAgentViews(
    key,
    { kind: 'environment', environmentId: 'env' },
    vi.fn()
  )
  expect(streams).toHaveLength(1)
  const snapshot = [{ paneKey: 'pane', sessionId: 'session', agentId: 'keyboard-child' }]
  streams[0].onEvent(snapshot)
  expect(readClaudeAgentViews(key)).toEqual(snapshot)
  await Promise.resolve()
  first()
  expect(close).not.toHaveBeenCalled()
  streams[0].onClose()
  expect(readClaudeAgentViews(key)).toEqual([])
  streams[0].onEvent(snapshot)
  expect(readClaudeAgentViews(key)).toEqual([])
  await vi.advanceTimersByTimeAsync(5000)
  expect(streams).toHaveLength(2)
  streams[1].onEvent([{ paneKey: 'pane', sessionId: 'session' }])
  expect(readClaudeAgentViews(key)).toEqual([{ paneKey: 'pane', sessionId: 'session' }])
  second()
  await Promise.resolve()
  expect(readClaudeAgentViews(key)).toEqual([])
  expect(close).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('degrades quietly with an older host that does not expose observed views', async () => {
  vi.useFakeTimers()
  subscribe.mockImplementation(async (_target, _method, _params, handlers) => {
    handlers.onError({ code: 'method_not_found' })
    return { unsubscribe: vi.fn() }
  })
  const release = subscribeClaudeAgentViews('older-host', { kind: 'local' }, vi.fn())
  await vi.advanceTimersByTimeAsync(15000)
  expect(readClaudeAgentViews('older-host')).toEqual([])
  expect(subscribe).toHaveBeenCalledTimes(1)
  release()
  await Promise.resolve()
})
