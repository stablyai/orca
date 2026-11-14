// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatComposerInterrupt } from './use-native-chat-composer-interrupt'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function setup() {
  vi.useFakeTimers()
  const stop = vi.fn()
  const cancel = vi.fn()
  const props = {
    scopeKey: 'chat-a',
    draft: '',
    inert: false,
    isWorking: true,
    onStop: stop,
    cancelPendingSends: cancel,
    resolveTarget: () => null
  }
  return {
    ...renderHook((input) => useNativeChatComposerInterrupt(input.scopeKey, input.draft, input), {
      initialProps: props
    }),
    props,
    stop,
    cancel
  }
}

it('keeps the turn and pending sends on first Escape and autorepeat, stopping on a second press', () => {
  const { result, stop, cancel } = setup()
  act(() => result.current.confirmEscape())
  expect(stop).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  act(() => result.current.confirmEscape(true))
  expect(stop).not.toHaveBeenCalled()
  act(() => result.current.confirmEscape())
  expect(stop).toHaveBeenCalledTimes(1)
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('requires a fresh confirmation after the first press expires', () => {
  const { result, stop } = setup()
  act(() => result.current.confirmEscape())
  act(() => vi.advanceTimersByTime(2_001))
  act(() => result.current.confirmEscape())
  expect(stop).not.toHaveBeenCalled()
  act(() => result.current.confirmEscape())
  expect(stop).toHaveBeenCalledTimes(1)
})

it('does not carry confirmation across drafts, chats, prompt cards or a settled turn', () => {
  const { result, rerender, props, stop } = setup()
  act(() => result.current.confirmEscape())
  rerender({ ...props, draft: 'Keep working' })
  act(() => result.current.confirmEscape())
  rerender({ ...props, scopeKey: 'chat-b' })
  act(() => result.current.confirmEscape())
  rerender({ ...props, inert: true })
  act(() => result.current.confirmEscape())
  rerender({ ...props, isWorking: false })
  rerender(props)
  act(() => result.current.confirmEscape())
  expect(stop).not.toHaveBeenCalled()
  act(() => result.current.confirmEscape())
  expect(stop).toHaveBeenCalledTimes(1)
})

it('keeps the explicit Stop action immediate', () => {
  const { result, stop, cancel } = setup()
  act(() => result.current.interrupt())
  expect(stop).toHaveBeenCalledTimes(1)
  expect(cancel).toHaveBeenCalledTimes(1)
})
