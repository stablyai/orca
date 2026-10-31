// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  recordRuntimeSubscription,
  stubRuntimeEnvironmentBridge
} from '../../runtime/runtime-environment-bridge-fixture'

vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironment: () => ({ id: 'env' }),
  manuallyDisconnectedEnvironmentIds: new Set<string>(),
  updateEnvironmentFromResponse: () => undefined
}))

import { createGitLabApi } from './web-gitlab-api'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('aborts host work for a cancelled item without cancelling another dialog', async () => {
  const first = recordRuntimeSubscription()
  const second = recordRuntimeSubscription()
  const subscribe = vi
    .fn()
    .mockImplementationOnce(first.subscribe)
    .mockImplementationOnce(second.subscribe)
  stubRuntimeEnvironmentBridge({
    subscribe,
    cancelSubscription: vi.fn().mockResolvedValue(undefined)
  })
  const api = createGitLabApi()
  const firstRequest = api.workItemDetails({
    repoPath: '/repo',
    iid: 1,
    type: 'issue',
    requestToken: 'one',
    includeImages: true
  })
  const secondRequest = api.workItemDetails({
    repoPath: '/repo',
    iid: 2,
    type: 'issue',
    requestToken: 'two'
  })
  const firstRejected = expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' })
  await Promise.resolve()
  await api.cancelWorkItemDetails({ requestToken: 'one' })
  await firstRejected
  expect(first.unsubscribe).toHaveBeenCalledOnce()
  expect(second.unsubscribe).not.toHaveBeenCalled()
  const secondRejected = expect(secondRequest).rejects.toMatchObject({ name: 'AbortError' })
  await api.cancelWorkItemDetails({ requestToken: 'two' })
  await secondRejected
  expect(second.unsubscribe).toHaveBeenCalledOnce()
})

it('times out an unresponsive preview and unsubscribes host work after thirty seconds', async () => {
  vi.useFakeTimers()
  const subscription = recordRuntimeSubscription()
  stubRuntimeEnvironmentBridge({
    subscribe: subscription.subscribe,
    cancelSubscription: vi.fn().mockResolvedValue(undefined)
  })
  const pending = createGitLabApi().workItemDetails({
    repoPath: '/repo',
    iid: 1,
    type: 'mr',
    requestToken: 'preview',
    includeImages: true,
    includeReviewDetails: false
  })
  const rejection = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(29_999)
  expect(subscription.unsubscribe).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await rejection
  expect(subscription.unsubscribe).toHaveBeenCalledOnce()
})
