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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const question = (n: number): AgentJournalQuestion => ({
  id: `q${n}`,
  question: `Question ${n}?`,
  header: `Step ${n}`,
  multiSelect: false,
  options: [
    { id: `q${n}:a`, label: `${n} A` },
    { id: `q${n}:b`, label: `${n} B` }
  ]
})

it('sends a partly answered set when the user skips the later questions and presses Submit', () => {
  vi.useFakeTimers()
  const onAnswer = vi.fn()
  const onCancel = vi.fn()
  act(() => {
    root.render(
      <NativeChatStructuredQuestionCard
        questions={[question(1), question(2), question(3)]}
        onAnswer={onAnswer}
        onCancel={onCancel}
      />
    )
  })
  const button = (name: string): HTMLElement => getByRole(container, 'button', { name })

  // Pick on step 1 (auto-advances), skip step 2, then submit from the unanswered last step.
  act(() => container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[1]!.click())
  act(() => vi.runAllTimers())
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
