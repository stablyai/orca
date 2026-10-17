// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render as renderView, screen } from '@testing-library/react'
import { useMemo, type ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPendingAsyncQuestions } from './NativeChatPendingAsyncQuestions'
import { NativeChatAsyncQuestions } from './NativeChatAsyncQuestions'
import { NativeChatAsyncQuestionContext } from './native-chat-async-question-context'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../shared/native-chat-question-auto-advance'

/** Supplies the tooltip context required by the real question card. */
function render(ui: ReactNode) {
  return renderView(ui, { wrapper: TooltipProvider })
}

const send = vi.fn(() => true)
const reply = { disabled: false, send }
const blockedReply = { disabled: true, send }
const asyncSend = vi.fn<(text: string) => Promise<boolean>>()
const asyncReply = { disabled: false, send: asyncSend }

const questions = [{ title: 'Which branch?', options: ['main', 'release'] }]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  send.mockReset().mockReturnValue(true)
  asyncSend.mockReset()
})

it.each(['release', 'my branch'])('sends a chosen or custom answer: %s', (answer) => {
  render(
    <NativeChatAsyncQuestionContext.Provider value={reply}>
      <NativeChatAsyncQuestions questions={questions} />
    </NativeChatAsyncQuestionContext.Provider>
  )
  if (answer === 'release') {
    fireEvent.click(screen.getByRole('button', { name: /release/ }))
  } else {
    fireEvent.change(screen.getByRole('textbox', { name: 'Other: type your answer' }), {
      target: { value: '  my branch  ' }
    })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(send).toHaveBeenCalledExactlyOnceWith(`Which branch?\n${answer}`)
  expect(screen.getByRole('button', { name: 'Reply' })).toBeVisible()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})

it('sends grouped answers together, including a question without suggestions', () => {
  vi.useFakeTimers()
  render(
    <NativeChatAsyncQuestionContext.Provider value={reply}>
      <NativeChatAsyncQuestions
        questions={[...questions, { title: 'Anything else?', options: [] }]}
      />
    </NativeChatAsyncQuestionContext.Provider>
  )
  fireEvent.click(screen.getByRole('button', { name: /release/ }))
  act(() => vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS))
  expect(send).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep the docs' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(send).toHaveBeenCalledExactlyOnceWith(
    'Which branch?\nrelease\n\nAnything else?\nKeep the docs'
  )
})

it('keeps the typed draft when folded and restores focus only when reopened', () => {
  vi.useFakeTimers()
  const view = render(<input aria-label="Composer" />)
  const composer = screen.getByRole('textbox', { name: 'Composer' })
  composer.focus()
  view.rerender(
    <>
      <input aria-label="Composer" />
      <NativeChatAsyncQuestionContext.Provider value={reply}>
        <NativeChatAsyncQuestions questions={questions} />
      </NativeChatAsyncQuestionContext.Provider>
    </>
  )
  act(() => vi.runOnlyPendingTimers())
  expect(composer).toHaveFocus()
  fireEvent.change(screen.getByRole('textbox', { name: 'Other: type your answer' }), {
    target: { value: 'unfinished answer' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  act(() => vi.runOnlyPendingTimers())
  expect(screen.getByRole('button', { name: 'Reply' })).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
  act(() => vi.runOnlyPendingTimers())
  const answer = screen.getByRole('textbox', { name: 'Other: type your answer' })
  expect(answer).toHaveValue('unfinished answer')
  expect(answer).toHaveFocus()
  expect(send).not.toHaveBeenCalled()
})

it('keeps the card and answer when the sender refuses the reply', () => {
  send.mockReturnValue(false)
  render(
    <NativeChatAsyncQuestionContext.Provider value={reply}>
      <NativeChatAsyncQuestions questions={questions} />
    </NativeChatAsyncQuestionContext.Provider>
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(send).toHaveBeenCalledExactlyOnceWith('Which branch?\nkeep this')
  expect(screen.getByRole('textbox')).toHaveValue('keep this')
  expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()
})

it('disables the controls while replies are blocked and keeps the draft', () => {
  const card = (disabled: boolean) => (
    <NativeChatAsyncQuestionContext.Provider value={disabled ? blockedReply : reply}>
      <NativeChatAsyncQuestions questions={questions} />
    </NativeChatAsyncQuestionContext.Provider>
  )
  const view = render(card(false))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wait for me' } })
  view.rerender(card(true))
  expect(screen.getByRole('textbox')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
  expect(send).not.toHaveBeenCalled()
  view.rerender(card(false))
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(send).toHaveBeenCalledExactlyOnceWith('Which branch?\nwait for me')
})

it('does not offer an unroutable card outside its session provider', () => {
  const { container } = render(<NativeChatAsyncQuestions questions={questions} />)
  expect(container).toBeEmptyDOMElement()
})

it('rechecks input ownership when a previously selected option auto-submits', () => {
  vi.useFakeTimers()
  const card = (disabled: boolean) => (
    <NativeChatAsyncQuestionContext.Provider value={disabled ? blockedReply : reply}>
      <NativeChatAsyncQuestions questions={questions} />
    </NativeChatAsyncQuestionContext.Provider>
  )
  const view = render(card(false))
  fireEvent.click(screen.getByRole('button', { name: /release/ }))
  view.rerender(card(true))
  act(() => vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS))
  expect(send).not.toHaveBeenCalled()
  view.rerender(card(false))
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(send).toHaveBeenCalledExactlyOnceWith('Which branch?\nrelease')
})

it.each([true, false])(
  'waits for delivery, keeping composer focus when accepted=%s',
  async (accepted) => {
    vi.useFakeTimers()
    const delivery = Promise.withResolvers<boolean>()
    asyncSend.mockReturnValue(delivery.promise)
    render(
      <>
        <input aria-label="Composer" />
        <NativeChatAsyncQuestionContext.Provider value={asyncReply}>
          <NativeChatAsyncQuestions questions={questions} />
        </NativeChatAsyncQuestionContext.Provider>
      </>
    )
    const answer = screen.getByRole('textbox', { name: 'Other: type your answer' })
    fireEvent.change(answer, { target: { value: 'my branch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(answer).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()
    const composer = screen.getByRole('textbox', { name: 'Composer' })
    composer.focus()
    await act(async () => {
      delivery.resolve(accepted)
    })
    act(() => vi.runOnlyPendingTimers())
    expect(composer).toHaveFocus()
    expect(asyncSend).toHaveBeenCalledExactlyOnceWith('Which branch?\nmy branch')
    if (accepted) {
      expect(screen.getByRole('button', { name: 'Reply' })).toBeVisible()
    } else {
      expect(answer).toBeEnabled()
      expect(answer).toHaveValue('my branch')
    }
  }
)

function PendingView({ groups }: { groups: { key: string; questions: typeof questions }[] }) {
  const value = useMemo(() => ({ ...reply, pendingQuestions: groups }), [groups])
  return (
    <NativeChatAsyncQuestionContext.Provider value={value}>
      <NativeChatPendingAsyncQuestions />
    </NativeChatAsyncQuestionContext.Provider>
  )
}

it('shows host pending cards without history rows and removes them after another client answers', () => {
  const view = render(<PendingView groups={[{ key: 'old-ask', questions }]} />)
  expect(screen.getByRole('textbox', { name: 'Other: type your answer' })).toBeVisible()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } })
  view.rerender(<PendingView groups={[{ key: 'old-ask', questions: [...questions] }]} />)
  expect(screen.getByRole('textbox')).toHaveValue('draft')
  view.rerender(<PendingView groups={[]} />)
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()
})

it('resets the wizard when another device answers its first question', () => {
  vi.useFakeTimers()
  const remaining = { title: 'Anything else?', options: [] }
  const view = render(
    <PendingView groups={[{ key: 'ask', questions: [...questions, remaining] }]} />
  )
  fireEvent.click(screen.getByRole('button', { name: /release/ }))
  act(() => vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS))
  view.rerender(<PendingView groups={[{ key: 'ask', questions: [remaining] }]} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep docs' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(send).toHaveBeenCalledExactlyOnceWith('Anything else?\nKeep docs')
})
