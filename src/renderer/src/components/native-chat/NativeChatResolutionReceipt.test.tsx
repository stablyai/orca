// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type {
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { encodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session/agent-session-question-answer'
import { NativeChatResolutionReceipt } from './NativeChatResolutionReceipt'
import { structuredQuestionTranscript } from '../../../../shared/structured-agent-question-projection'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'
import {
  nativeChatReceiptAnswers,
  type NativeChatResolvedPrompt
} from '../../../../shared/native-chat/native-chat-resolution-receipt'

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

  it('keeps an opened question open once it is answered', () => {
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => 400
    })
    const pendingBody: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Which of the three migration strategies should I use?',
      options: [{ id: 'a', label: 'Strategy A' }],
      resolution: { ...approval.resolution, state: 'pending', selectedOptionId: null }
    }
    function Harness({ body }: { body: AgentJournalQuestionItem }): React.JSX.Element {
      const disclosures = useNativeChatDisclosures()
      return (
        <NativeChatDisclosureContext.Provider value={disclosures}>
          <NativeChatResolutionReceipt body={body} disclosureId="message-1" />
        </NativeChatDisclosureContext.Provider>
      )
    }
    try {
      const { rerender } = render(<Harness body={pendingBody} />)
      fireEvent.click(screen.getByRole('button', { name: /Awaiting user input:/ }))

      rerender(
        <Harness
          body={{ ...pendingBody, resolution: { ...approval.resolution, selectedOptionId: 'a' } }}
        />
      )
      expect(screen.getByRole('button', { name: /Asked:/ })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    } finally {
      if (scrollWidth) {
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth)
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
      }
    }
  })

  describe('a grouped question', () => {
    const FIRST = 'Which of the three migration strategies should I use for the orders table?'
    const SECOND = 'Should the old columns be dropped in the same release?'
    const grouped: AgentJournalQuestionItem = {
      kind: 'question',
      question: '2 grouped questions from Claude',
      options: [],
      questions: [
        { id: 'q1', question: FIRST, multiSelect: false, options: [{ id: 'a', label: 'A' }] },
        { id: 'q2', question: SECOND, multiSelect: false, options: [{ id: 'y', label: 'Yes' }] }
      ],
      resolution: { state: 'cancelled', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }

    function Harness({
      body,
      mounted = true
    }: {
      body: AgentJournalQuestionItem
      mounted?: boolean
    }): React.JSX.Element {
      const disclosures = useNativeChatDisclosures()
      return (
        <NativeChatDisclosureContext.Provider value={disclosures}>
          {mounted ? <NativeChatResolutionReceipt body={body} disclosureId="message-1" /> : null}
        </NativeChatDisclosureContext.Provider>
      )
    }

    it('lists every question of a cancelled prompt below its toggle', () => {
      const { rerender } = render(<Harness body={grouped} />)
      const toggle = screen.getByRole('button', { name: /Asked:\s*2 questions/ })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText(FIRST)).toBeNull()

      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(toggle).toHaveTextContent('2 questions')
      const items = screen.getAllByRole('listitem')
      expect(items.map((item) => item.textContent)).toEqual([FIRST, SECOND])
      expect(items[0]?.closest('button')).toBeNull()
      fireEvent.click(items[0]!)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')

      rerender(<Harness body={grouped} mounted={false} />)
      rerender(<Harness body={grouped} />)
      const remounted = screen.getByRole('button', { name: /Asked:/ })
      expect(remounted).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText(SECOND)).toBeInTheDocument()

      // Folding keeps the same control, so keyboard focus is not dropped.
      remounted.focus()
      fireEvent.click(remounted)
      expect(document.activeElement).toBe(remounted)
      expect(remounted).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('list')).toBeNull()
    })

    it('does not carry an opened Codex group onto its first question once answered', () => {
      const codexQuestion = (
        itemId: string,
        question: string,
        resolution: AgentJournalQuestionItem['resolution'] = {
          state: 'pending',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null
        }
      ): AgentJournalRenderItem => ({
        itemId,
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: {
          kind: 'question',
          question,
          options: [{ id: `${itemId}-a`, label: 'A' }],
          resolution
        }
      })
      const receiptFor = (items: AgentJournalRenderItem[]): AgentJournalQuestionItem => {
        const body = structuredQuestionTranscript(items).receipts.get('message-1')
        if (body?.kind !== 'question') {
          throw new Error('expected a question receipt')
        }
        return body
      }
      const second = codexQuestion('message-2', SECOND)
      const { rerender } = render(
        <Harness body={receiptFor([codexQuestion('message-1', 'Branch?'), second])} />
      )
      fireEvent.click(screen.getByRole('button', { name: /Awaiting user input:\s*2 questions/ }))
      expect(screen.getByText('Branch?')).toBeInTheDocument()

      // Answering the first question gives it its own row under the group's id.
      const answered = codexQuestion('message-1', 'Branch?', {
        state: 'resolved',
        selectedOptionId: 'message-1-a',
        resolvedBy: null,
        resolvedAt: 1000
      })
      rerender(<Harness body={receiptFor([answered, second])} />)
      expect(screen.getByText('Branch?')).toHaveClass('truncate')
      expect(screen.getByRole('button', { name: /Asked:/ })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    })
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

  it('reads the recorded structured answers before the packed form', () => {
    const typed = 'Wait for the capture to finish. '.repeat(50).trim()
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Name?',
      options: [{ id: 'q1:choice-1', label: 'Default' }],
      freeTextQuestionId: 'q1',
      resolution: {
        ...approval.resolution,
        // The packed copy only older clients read; it must not win over the recorded answer.
        selectedOptionId: 'q1:choice-1',
        answers: [{ questionId: 'q1', optionIds: [], other: typed }]
      }
    }

    expect(nativeChatReceiptAnswers(body)).toEqual([{ question: null, answer: typed }])
  })
})
