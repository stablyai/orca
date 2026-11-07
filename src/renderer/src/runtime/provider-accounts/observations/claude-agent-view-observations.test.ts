import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcSubscriptionHandlers } from '../../rpc/subscriptions/runtime-rpc-subscribe'

const subscribe = vi.hoisted(() => vi.fn())
vi.mock('../../rpc/subscriptions/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: subscribe }))

import { readClaudeAgentViews, subscribeClaudeAgentViews } from './claude-agent-view-observations'

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('clears disconnected observations until fresh evidence arrives', async () => {
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
  const snapshot = [{ paneKey: 'pane', sessionId: 'session', agentId: 'keyboard-child' }]
  streams[0].onEvent(snapshot)
  expect(readClaudeAgentViews(key)).toEqual([
    { paneKey: 'pane', sessionId: 'session', agentId: 'keyboard-child' }
  ])
  await Promise.resolve()
  first()
  streams[0].onClose()
  expect(readClaudeAgentViews(key)).toEqual([])
  streams[0].onEvent(snapshot)
  expect(readClaudeAgentViews(key)).toEqual([])
  await vi.advanceTimersByTimeAsync(5000)
  streams[1].onEvent([{ paneKey: 'pane', sessionId: 'session' }])
  expect(readClaudeAgentViews(key)).toEqual([{ paneKey: 'pane', sessionId: 'session' }])
  second()
  await Promise.resolve()
  expect(readClaudeAgentViews(key)).toEqual([])
})
