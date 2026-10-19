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
      clearCapable: true,
      cards: [],
      pause: null,
      clear: vi.fn(async () => true),
      queuePending: null,
      pending: () => null,
      resume: vi.fn(async () => {
        order.push('resume')
        return true
      }),
      steer: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      edit: vi.fn(async () => {}),
      editCapable: false,
      editor: undefined,
      steerNewest: vi.fn(() => false)
    }
  }
  const retryLaunch = (): number => order.push('launch')
  const { result } = renderHook(() => useStructuredNativeChatSubmitReveal(controller, retryLaunch))
  result.current.messageListRef.current = {
    revealLatest: () => order.push('reveal'),
    revealFindMatch: () => {},
    messageCopyText: () => null
  }

  act(() => result.current.retryLaunch())
  await act(() => result.current.queuedMessages.resume())

  expect(order).toEqual(['reveal', 'launch', 'resume', 'reveal'])
})

// STA-10671: an older host held for its permission mode would run a queued card unprompted.
it('sends no queued card and retries no start on a host held for its permission mode', async () => {
  const queuedMessages = {
    queueCapable: true,
    clearCapable: true,
    cards: [],
    pause: { reason: 'stopped' },
    queuePending: null,
    pending: () => null,
    clear: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    steer: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    editCapable: false,
    editor: undefined,
    steerNewest: vi.fn(() => true)
  }
  const controller = { respond: vi.fn(async () => null), queuedMessages }
  const retryLaunch = vi.fn()
  const { result } = renderHook(() =>
    useStructuredNativeChatSubmitReveal(controller, retryLaunch, true)
  )

  await act(() => result.current.queuedMessages.resume())
  await act(() => result.current.queuedMessages.steer('m1'))
  expect(result.current.queuedMessages.steerNewest()).toBe(false)
  expect(queuedMessages.resume).not.toHaveBeenCalled()
  expect(queuedMessages.steer).not.toHaveBeenCalled()
  expect(queuedMessages.steerNewest).not.toHaveBeenCalled()
  act(() => result.current.retryLaunch())
  expect(retryLaunch).not.toHaveBeenCalled()
})
