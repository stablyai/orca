// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { getByRole } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalQuestion } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

/** A question the host lets go unanswered, or (`skippable: false`) one it requires. */
const question = (n: number, skippable = true): AgentJournalQuestion => ({
  id: `q${n}`,
  question: `Question ${n}?`,
  header: `Step ${n}`,
  multiSelect: false,
  options: [
    { id: `q${n}:a`, label: `${n} A` },
    { id: `q${n}:b`, label: `${n} B` }
  ],
  ...(skippable ? { skippable: true as const } : {})
})

function renderCard(questions: AgentJournalQuestion[]) {
  const onAnswer = vi.fn()
  const onCancel = vi.fn()
  act(() => {
    root.render(
      <NativeChatStructuredQuestionCard
        questions={questions}
        onAnswer={onAnswer}
        onCancel={onCancel}
      />
    )
  })
  return { onAnswer, onCancel }
}

const button = (name: string): HTMLButtonElement => {
  const found = getByRole(container, 'button', { name })
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`${name} is not a button`)
  }
  return found
}
const title = (): string | null =>
  container.querySelector('[data-testid="native-chat-question-card-title"]')!.textContent
/** Picks an option on the current step and lets the single-select auto-advance run. */
const pick = (optionIndex: number): void => {
  act(() =>
    container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[optionIndex]!.click()
  )
  act(() => vi.runAllTimers())
}

it('sends a partly answered set when the user skips the later questions and presses Submit', () => {
  const { onAnswer, onCancel } = renderCard([question(1), question(2), question(3)])

  pick(1)
  act(() => button('Skip').click())
  act(() => button('Submit').click())

  expect(onCancel).not.toHaveBeenCalled()
  expect(onAnswer).toHaveBeenCalledTimes(1)
  expect(onAnswer).toHaveBeenCalledWith({
    kind: 'answers',
    answers: [
      { questionId: 'q1', optionIds: ['q1:b'] },
      { questionId: 'q2', optionIds: [] },
      { questionId: 'q3', optionIds: [] }
    ]
  })
})

it('offers no Skip on a required question and takes Submit back to it instead of sending', () => {
  // Also how every question from a host that predates skippable questions behaves.
  const { onAnswer } = renderCard([
    question(1),
    { ...question(2, false), freeTextQuestionId: 'q2' },
    question(3)
  ])
  const step = (n: number): void =>
    act(() =>
      container.querySelectorAll<HTMLButtonElement>('[data-native-chat-question-step]')[n]!.click()
    )

  pick(1)
  expect(title()).toBe('Question 2?')
  expect(button('Next').disabled).toBe(true)
  // Enter on the unanswered required step keeps it too.
  act(() => {
    container
      .querySelector<HTMLTextAreaElement>('[data-native-chat-answer-field]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(title()).toBe('Question 2?')

  // Jumping past it by its step chip: Submit returns to it rather than sending.
  step(2)
  act(() => button('Submit').click())
  expect(onAnswer).not.toHaveBeenCalled()
  expect(title()).toBe('Question 2?')

  pick(0)
  act(() => button('Submit').click())
  expect(onAnswer).toHaveBeenCalledWith({
    kind: 'answers',
    answers: [
      { questionId: 'q1', optionIds: ['q1:b'] },
      { questionId: 'q2', optionIds: ['q2:a'] },
      { questionId: 'q3', optionIds: [] }
    ]
  })
})

it('keeps Submit idle on an unanswered required last question until it is answered', () => {
  const { onAnswer } = renderCard([question(1), question(2, false)])

  pick(1)
  expect(title()).toBe('Question 2?')
  expect(button('Submit').disabled).toBe(true)

  pick(0)
  expect(onAnswer).toHaveBeenCalledWith({
    kind: 'answers',
    answers: [
      { questionId: 'q1', optionIds: ['q1:b'] },
      { questionId: 'q2', optionIds: ['q2:a'] }
    ]
  })
})
