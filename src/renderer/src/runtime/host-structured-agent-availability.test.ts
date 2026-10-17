import { expect, it, vi } from 'vitest'

const subscribe = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: subscribe }))

import {
  acquireHostStructuredAgentAvailability as acquire,
  readHostStructuredAgentAvailability as read
} from './host-structured-agent-availability'

it('shares one stream per workspace, reads a lost one as unknown, and closes with its last holder', async () => {
  const unsubscribe = vi.fn()
  subscribe.mockResolvedValue({ unsubscribe })
  const owner = { target: { kind: 'local' }, executionHostId: 'local', runtimeId: null } as const
  const releaseMenu = acquire({ ...owner, worktreeId: 'wt' })
  const releaseOther = acquire({ ...owner, worktreeId: 'wt' })
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(subscribe.mock.calls[0][2]).toEqual({ worktree: 'id:wt' })
  expect(read('local', null, 'wt')).toEqual({ ready: false })

  const handlers = subscribe.mock.calls[0][3]
  const pi = { agent: 'pi', state: 'refused' }
  handlers.onEvent({ type: 'availability', agents: [pi] })
  expect(read('local', null, 'wt')).toEqual({ ready: true, byAgent: new Map([['pi', pi]]) })
  releaseMenu()
  await Promise.resolve()
  expect(unsubscribe).not.toHaveBeenCalled()
  handlers.onClose()
  expect(read('local', null, 'wt')).toEqual({ ready: true, byAgent: new Map() })
  expect(unsubscribe).toHaveBeenCalledTimes(1)

  releaseOther()
  await Promise.resolve()
  expect(read('local', null, 'wt')).toEqual({ ready: false })
})
