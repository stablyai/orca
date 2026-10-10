// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useStructuredNativeChatSubmitReveal } from './use-structured-native-chat-submit-reveal'

it('reveals before launch Retry, but waits for a successful queue Resume', async () => {
  const order: string[] = []
  const controller = {
    respond: vi.fn(async () => null),
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
      editCapable: false,
      editor: undefined,
      steerNewest: vi.fn(() => false),
      queueResume: undefined,
      queueHold: undefined
    }
  }
  const retryLaunch = (): number => order.push('launch')
  const { result } = renderHook(() => useStructuredNativeChatSubmitReveal(controller, retryLaunch))
  result.current.messageListRef.current = {
    revealLatest: () => order.push('reveal'),
    revealFindMatch: () => {}
  }

  act(() => result.current.retryLaunch())
  await act(() => result.current.queuedMessages.resume())

  expect(order).toEqual(['reveal', 'launch', 'resume', 'reveal'])
})
