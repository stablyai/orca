// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useStructuredNativeChatSubmitReveal } from './use-structured-native-chat-submit-reveal'

it('reveals before Retry, but waits for a successful queue Resume', async () => {
  const order: string[] = []
  const controller = {
    respond: vi.fn(async () => null),
    retry: vi.fn(() => order.push('retry')),
    queuedMessages: {
      queueCapable: true,
      cards: [],
      pause: null,
      resuming: false,
      resume: vi.fn(async () => {
        order.push('resume')
        return true
      }),
      steer: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      edit: vi.fn(async () => {}),
      steerNewest: vi.fn(() => false)
    }
  }
  const retryLaunch = (): number => order.push('launch')
  const { result } = renderHook(() => useStructuredNativeChatSubmitReveal(controller, retryLaunch))
  result.current.messageListRef.current = { revealLatest: () => order.push('reveal') }

  act(() => result.current.retryDelivery('client-1'))
  act(() => result.current.retryLaunch())
  await act(() => result.current.queuedMessages.resume())

  expect(controller.retry).toHaveBeenCalledWith('client-1')
  expect(order).toEqual(['reveal', 'retry', 'reveal', 'launch', 'resume', 'reveal'])
})
