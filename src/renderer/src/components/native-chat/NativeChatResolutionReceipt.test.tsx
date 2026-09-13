// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type { AgentJournalQuestionItem } from '../../../../shared/agent-session-journal-types'
import { encodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session-question-answer'
import { NativeChatResolutionReceipt } from './NativeChatResolutionReceipt'
import {
  nativeChatReceiptAnswers,
  type NativeChatResolvedPrompt
} from './native-chat-resolution-receipt'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})
const approval: NativeChatResolvedPrompt = {
  kind: 'approval',
  title: 'Run command?',
  detail: 'pnpm test',
  options: [
    { id: 'yes', label: 'Allow once' },
    { id: 'no', label: 'Deny' }
  ],
  resolution: {
    state: 'resolved',
    selectedOptionId: 'yes',
    resolvedBy: 'phone-client',
    resolvedAt: 1000
  }
}

describe('resolution receipts', () => {
  it('localizes the resolved time when the UI language changes', async () => {
    render(<NativeChatResolutionReceipt body={approval} />)
    await act(async () => {
      await i18n.changeLanguage('fr')
    })
    expect(screen.getByRole('time')).toHaveTextContent(
      new Intl.DateTimeFormat('fr', { hour: 'numeric', minute: '2-digit' }).format(1000)
    )
    expect(screen.getByRole('time')).toHaveAccessibleName(
      new Intl.DateTimeFormat('fr', { dateStyle: 'full', timeStyle: 'long' }).format(1000)
    )
  })

  it.each([
    ['yes', 'Allow once'],
    ['no', 'Deny']
  ])('shows the exact selected approval label for %s', (id, label) => {
    render(
      <NativeChatResolutionReceipt
        body={{ ...approval, resolution: { ...approval.resolution, selectedOptionId: id } }}
      />
    )
    expect(screen.getByText('Run command?')).toBeInTheDocument()
    expect(screen.getByText('pnpm test')).toBeInTheDocument()
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText('Answered on phone-client')).toBeInTheDocument()
    expect(document.querySelector('time')).toHaveAttribute('datetime', new Date(1000).toISOString())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders cancellation quietly without inventing a choice or resolver', () => {
    render(
      <NativeChatResolutionReceipt
        body={{
          ...approval,
          resolution: {
            state: 'cancelled',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }}
      />
    )
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.queryByText('Allow once')).toBeNull()
    expect(screen.queryByText('Selected answer unavailable')).toBeNull()
    expect(document.querySelector('time')).toBeNull()
  })

  it.each([null, 'unknown'])('handles absent or unknown selections (%s)', (selectedOptionId) => {
    render(
      <NativeChatResolutionReceipt
        body={{ ...approval, resolution: { ...approval.resolution, selectedOptionId } }}
      />
    )
    expect(screen.getByText('Selected answer unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Allow once')).toBeNull()
  })

  it('excludes pending prompts', () => {
    const { container } = render(
      <NativeChatResolutionReceipt
        body={{ ...approval, resolution: { ...approval.resolution, state: 'pending' } }}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('reads grouped options from each question despite an empty flat options list', () => {
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Choose settings',
      options: [],
      questions: [
        {
          id: 'q1',
          question: 'Features?',
          multiSelect: true,
          options: [
            { id: 'a', label: 'First' },
            { id: 'b', label: 'Second' }
          ]
        },
        { id: 'q2', question: 'Name?', multiSelect: false, options: [], freeTextQuestionId: 'q2' }
      ],
      resolution: {
        ...approval.resolution,
        selectedOptionId: encodeAgentSessionQuestionAnswers([
          { questionId: 'q1', optionIds: ['a', 'b'] },
          { questionId: 'q2', optionIds: [], other: 'Custom 100% name' }
        ])
      }
    }
    render(<NativeChatResolutionReceipt body={body} />)
    expect(screen.getByText('Features?')).toBeInTheDocument()
    expect(screen.getByText('First · Second')).toBeInTheDocument()
    expect(screen.getByText('Custom 100% name')).toBeInTheDocument()
    expect(screen.queryByText('Selected answer unavailable')).toBeNull()
    expect(
      nativeChatReceiptAnswers({
        ...body,
        resolution: { ...body.resolution, selectedOptionId: 'question-group:invalid' }
      })
    ).toEqual([
      { question: 'Features?', answer: null },
      { question: 'Name?', answer: null }
    ])
  })

  it('decodes single free-text answers only for the declared question', () => {
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Name?',
      options: [],
      freeTextQuestionId: 'name/id',
      resolution: { ...approval.resolution, selectedOptionId: 'name%2Fid:hello%20world' }
    }
    expect(nativeChatReceiptAnswers(body)).toEqual([{ question: null, answer: 'hello world' }])
    for (const selectedOptionId of ['other:hello', 'name%2Fid:%invalid']) {
      expect(
        nativeChatReceiptAnswers({ ...body, resolution: { ...body.resolution, selectedOptionId } })
      ).toEqual([{ question: null, answer: null }])
    }
  })
})
