import { beforeEach, expect, it, vi } from 'vitest'

const subscribe = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: subscribe }))

import {
  acquireHostStructuredAgentAvailability as acquire,
  readHostStructuredAgentAvailability as read
} from './host-structured-agent-availability'

const unsubscribe = vi.fn()
const owner = {
  target: { kind: 'environment', environmentId: 'env' },
  executionHostId: 'runtime:env',
  runtimeId: 'r1',
  pairingRevision: 1
} as const
const handlers = (call: number) => subscribe.mock.calls[call][3]

beforeEach(() => {
  subscribe.mockReset().mockResolvedValue({ unsubscribe })
})

it('keeps the snapshot through lost contact and after its last holder, until the host is re-paired', async () => {
  const release = acquire(owner)
  acquire(owner)()
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(subscribe.mock.calls[0][2]).toEqual({})
  expect(read('runtime:env', 'r1', 1)).toEqual({ state: 'pending' })
  const pi = { agent: 'pi', state: 'refused' }
  handlers(0).onEvent({ type: 'availability', agents: [pi] })
  const known = { state: 'received', byAgent: new Map([['pi', pi]]) }

  handlers(0).onClose()
  expect(read('runtime:env', 'r1', 1)).toEqual(known)
  // A reconnect reopens the stream; the snapshot stays until the host replays its own.
  acquire(owner)
  expect(subscribe).toHaveBeenCalledTimes(2)
  expect(read('runtime:env', 'r1', 1)).toEqual(known)
  release()
  await Promise.resolve()
  expect(read('runtime:env', 'r1', 1)).toEqual(known)

  acquire({ ...owner, pairingRevision: 2 })
  expect(read('runtime:env', 'r1', 2)).toEqual({ state: 'pending' })
})

it('distinguishes first-stream failure from an authoritative empty roster, retaining failure during reacquire', () => {
  acquire({ ...owner, runtimeId: 'r2' })
  handlers(0).onError(new Error('lost'))
  expect(read('runtime:env', 'r2', 1)).toEqual({ state: 'unavailable' })
  acquire({ ...owner, runtimeId: 'r2' })
  expect(read('runtime:env', 'r2', 1)).toEqual({ state: 'unavailable' })
  handlers(1).onEvent({ type: 'availability', agents: [] })
  expect(read('runtime:env', 'r2', 1)).toEqual({ state: 'received', byAgent: new Map() })
})
