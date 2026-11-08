// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from '../messages/actions/native-chat-tooltip-test-harness'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type {
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'

import { NativeChatResolutionReceipt } from './NativeChatResolutionReceipt'
import { structuredQuestionTranscript } from '../../../../../shared/structured-agent-question-projection'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../messages/disclosure/native-chat-disclosure-store'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('resolution receipts', () => {
  describe('a grouped question', () => {
    const SECOND = 'Should the old columns be dropped in the same release?'

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
})
