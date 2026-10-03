// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useStructuredNativeChatSubmitReveal } from './use-structured-native-chat-submit-reveal'

// Submits outside the composer: each is the reader acting, so each brings the latest into view.
it('reveals the latest for a delivery Retry, a launch Retry and a queue Resume, before they act', async () => {
  const order: string[] = []
  const controller = {
    respond: vi.fn(async () => null),
    retry: vi.fn(() => order.push('retry')),
    queuedMessages: {
      cards: [],
      pause: null,
      resuming: false,
      resume: vi.fn(async () => {
        order.push('resume')
      }),
      steer: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      edit: vi.fn(async () => {}),
      steerNewest: vi.fn(() => false)
    }
  }
  const retryLaunch = (): number => order.push('launch')
  const { result } = renderHook(() => useStructuredNativeChatSubmitReveal(controller, retryLaunch))
  result.current.messageListRef.current = {
    revealLatest: () => order.push('reveal'),
    holdRevealLatest: () => () => order.push('reveal')
  }

  act(() => result.current.retryDelivery('client-1'))
  act(() => result.current.retryLaunch())
  await act(() => result.current.queuedMessages.resume())

  expect(controller.retry).toHaveBeenCalledWith('client-1')
  expect(order).toEqual(['reveal', 'retry', 'reveal', 'launch', 'reveal', 'resume'])
})
