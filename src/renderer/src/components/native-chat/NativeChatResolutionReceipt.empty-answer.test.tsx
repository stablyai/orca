// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalQuestionItem } from '../../../../shared/agent-session-journal-types'
import { NativeChatResolutionReceipt } from './NativeChatResolutionReceipt'
import { nativeChatReceiptAnswers } from './native-chat-resolution-receipt'

afterEach(cleanup)

// A Pi input dialog the user answered with nothing: the provider accepts an empty answer.
const emptyInput: AgentJournalQuestionItem = {
  kind: 'question',
  question: 'Enter text',
  options: [],
  freeTextQuestionId: 'text',
  freeTextInput: { allowEmpty: true },
  resolution: {
    state: 'resolved',
    selectedOptionId: 'text:',
    answers: [{ questionId: 'text', optionIds: [], other: '' }],
    resolvedBy: null,
    resolvedAt: 1000
  }
}

describe('an explicitly empty text answer', () => {
  it('reads as answered with nothing, not as an answer Orca cannot read', () => {
    render(<NativeChatResolutionReceipt body={emptyInput} />)

    expect(screen.getByText('Empty answer')).toBeInTheDocument()
    expect(screen.queryByText('Selected answer unavailable')).toBeNull()
    expect(nativeChatReceiptAnswers(emptyInput)).toEqual([{ question: null, answer: '' }])
  })

  it('counts whitespace alone as empty', () => {
    const blank = {
      ...emptyInput,
      resolution: {
        ...emptyInput.resolution,
        answers: [{ questionId: 'text', optionIds: [], other: '  \n ' }]
      }
    }
    expect(nativeChatReceiptAnswers(blank)).toEqual([{ question: null, answer: '' }])
  })

  it('still says unavailable when the answer names no text and no option', () => {
    const missing = {
      ...emptyInput,
      resolution: {
        ...emptyInput.resolution,
        answers: [{ questionId: 'text', optionIds: [] }]
      }
    }
    render(<NativeChatResolutionReceipt body={missing} />)

    expect(screen.getByText('Selected answer unavailable')).toBeInTheDocument()
  })
})
