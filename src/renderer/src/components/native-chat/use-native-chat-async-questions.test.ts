// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatAsyncAnswerOutcome } from '../../../../shared/native-chat-async-question-answers'
import type {
  NativeChatAsyncQuestion,
  NativeChatAsyncQuestionsView
} from '../../../../shared/native-chat-async-questions'
import { clearNativeChatAsyncQuestionCardStoreForTests } from './native-chat-async-question-card-store'
import {
  useNativeChatAsyncQuestions,
  type NativeChatAsyncAnswerSend
} from './use-native-chat-async-questions'

afterEach(() => {
  cleanup()
  clearNativeChatAsyncQuestionCardStoreForTests()
})

const q = (key: string, title = `${key}?`, options?: string[]): NativeChatAsyncQuestion => ({
  key,
  index: 0,
  title,
  ...(options ? { options } : {})
})
const ready = (...questions: NativeChatAsyncQuestion[]): NativeChatAsyncQuestionsView => ({
  state: 'ready',
  questions
})

function deferredSend(): {
  send: NativeChatAsyncAnswerSend & ReturnType<typeof vi.fn>
  settle: (outcome: NativeChatAsyncAnswerOutcome) => Promise<void>
} {
  let resolve: (outcome: NativeChatAsyncAnswerOutcome) => void = () => {}
  const send = vi.fn(
    () =>
      new Promise<NativeChatAsyncAnswerOutcome>((done) => {
        resolve = done
      })
  )
  return {
    send,
    settle: async (outcome) => {
      await act(async () => {
        resolve(outcome)
        await Promise.resolve()
      })
    }
  }
}

function render(view: NativeChatAsyncQuestionsView, send: NativeChatAsyncAnswerSend) {
  return renderHook(
    (props: { view: NativeChatAsyncQuestionsView; scopeKey: string }) =>
      useNativeChatAsyncQuestions({ ...props, send }),
    { initialProps: { view, scopeKey: 'pane:s' } }
  )
}

describe('useNativeChatAsyncQuestions', () => {
  it('needs an answer or a dismissal for every shown question before Send', () => {
    const { send } = deferredSend()
    const { result } = render(ready(q('a'), q('b', 'B?', ['Yes'])), send)
    act(() => result.current.edit('a', { text: 'Orca' }))
    expect(result.current.canSend).toBe(false)
    act(() => result.current.edit('b', { option: 'Yes' }))
    expect(result.current.canSend).toBe(true)
    act(() => result.current.edit('b', {}))
    act(() => result.current.dismiss('b'))
    expect(result.current.open.map((question) => question.key)).toEqual(['a'])
    expect(result.current.canSend).toBe(true)
  })

  it('keeps A while B arrives before the tap: Send waits for B; dismissed B is not sent', async () => {
    const { send, settle } = deferredSend()
    const { result, rerender } = render(ready(q('a')), send)
    act(() => result.current.edit('a', { text: 'one' }))
    rerender({ view: ready(q('a'), q('b')), scopeKey: 'pane:s' })
    expect(result.current.edits.a).toEqual({ text: 'one' })
    expect(result.current.canSend).toBe(false)
    act(() => result.current.dismiss('b'))
    act(() => result.current.submit())
    expect(send).toHaveBeenCalledWith('Question: a?\nAnswer: one', { a: 'one' })
    await settle('accepted')
  })

  it('disables Send while in flight and clears the sent edits once accepted; the card stays', async () => {
    const { send, settle } = deferredSend()
    const { result } = render(ready(q('a')), send)
    act(() => result.current.edit('a', { text: 'one' }))
    act(() => result.current.submit())
    expect(result.current.sending).toBe(true)
    expect(result.current.canSend).toBe(false)
    act(() => result.current.submit())
    expect(send).toHaveBeenCalledOnce()
    await settle('accepted')
    expect(result.current.sending).toBe(false)
    expect(result.current.edits.a).toBeUndefined()
    expect(result.current.open.map((question) => question.key)).toEqual(['a'])
  })

  it.each(['rejected', 'unknown', 'withdrawn'] as const)(
    'keeps the edits and re-enables Send after %s',
    async (outcome) => {
      const { send, settle } = deferredSend()
      const { result } = render(ready(q('a')), send)
      act(() => result.current.edit('a', { text: 'one' }))
      act(() => result.current.submit())
      await settle(outcome)
      expect(result.current.edits.a).toEqual({ text: 'one' })
      expect(result.current.canSend).toBe(true)
    }
  )

  it('treats a queued answer as delivered; a deleted queued message leaves the card sendable', async () => {
    const { send, settle } = deferredSend()
    const { result } = render(ready(q('a')), send)
    act(() => result.current.edit('a', { text: 'one' }))
    act(() => result.current.submit())
    await settle('queued')
    expect(result.current.open).toHaveLength(1)
    act(() => result.current.edit('a', { text: 'again' }))
    expect(result.current.canSend).toBe(true)
  })

  it('keeps edits and dismissals through pending and absent views; a ready set prunes them', () => {
    const { send } = deferredSend()
    const { result, rerender } = render(ready(q('a'), q('b')), send)
    act(() => result.current.edit('a', { text: 'one' }))
    act(() => result.current.dismiss('b'))
    rerender({ view: { state: 'pending' }, scopeKey: 'pane:s' })
    expect(result.current.open).toEqual([])
    rerender({ view: ready(q('a'), q('b')), scopeKey: 'pane:s' })
    expect(result.current.edits.a).toEqual({ text: 'one' })
    expect(result.current.open.map((question) => question.key)).toEqual(['a'])
    rerender({ view: { state: 'absent' }, scopeKey: 'pane:s' })
    rerender({ view: ready(q('a'), q('b')), scopeKey: 'pane:s' })
    expect(result.current.edits.a).toEqual({ text: 'one' })
    rerender({ view: ready(), scopeKey: 'pane:s' })
    rerender({ view: ready(q('a')), scopeKey: 'pane:s' })
    expect(result.current.edits.a).toBeUndefined()
  })

  it('shows every pending question (no count cap) and starts clean in another session', () => {
    const { send } = deferredSend()
    const many = Array.from({ length: 17 }, (_, index) => q(`k${index}`))
    const { result, rerender } = render(ready(...many), send)
    expect(result.current.open).toHaveLength(17)
    act(() => result.current.edit('k0', { text: 'x' }))
    rerender({ view: ready(...many), scopeKey: 'pane:other' })
    expect(result.current.edits.k0).toBeUndefined()
  })

  it('keeps edits, dismissals and an in-flight send across a terminal/chat toggle', async () => {
    const { send, settle } = deferredSend()
    const view = ready(q('a'), q('b'), q('c'))
    const first = render(view, send)
    act(() => first.result.current.edit('a', { text: 'one' }))
    act(() => first.result.current.dismiss('b'))
    act(() => first.result.current.edit('c', { text: 'two' }))
    act(() => first.result.current.submit())
    // The card unmounts with the chat view; the send settles while it is away.
    first.unmount()
    const second = render(view, send)
    expect(second.result.current.sending).toBe(true)
    expect(second.result.current.open.map((question) => question.key)).toEqual(['a', 'c'])
    await settle('rejected')
    expect(second.result.current.sending).toBe(false)
    expect(second.result.current.edits).toEqual({ a: { text: 'one' }, c: { text: 'two' } })
    second.unmount()
    const third = render(view, send)
    expect(third.result.current.open.map((question) => question.key)).toEqual(['a', 'c'])
    expect(third.result.current.canSend).toBe(true)
  })
})
