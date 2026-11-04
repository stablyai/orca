import { expect, it, vi } from 'vitest'
import { scanPendingAsks } from './native-chat-ask'
import { projectStructuredAgentSessionMessages } from '../../agent-session/view/structured-agent-session-message-projection'
import { agentJournalSubmissionKey } from '../../agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../agent-session/journal/agent-session-journal-types'

it('bounds causal merging and pending queue quote matching on actual N/10N projections', () => {
  function measure(count: number) {
    const items: AgentJournalRenderItem[] = []
    const submissions: AgentJournalSubmission[] = []
    for (let index = 0; index < count; index++) {
      const id = String(index)
      items.push({
        itemId: `ask-${id}`,
        sequence: 2 * index + 1,
        revision: 0,
        observedAt: index,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [
            {
              type: 'tool-call',
              name: 'request_user_input_async',
              callId: id,
              input: { questions: [{ title: `Question ${id}?`, options: ['Yes', 'No'] }] }
            }
          ]
        }
      })
      items.push({
        itemId: agentJournalSubmissionKey(id),
        sequence: 2 * index + 2,
        revision: 0,
        observedAt: index,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: `> Question ${id}?\n\nYes` }]
        }
      })
      submissions.push({
        clientMessageId: id,
        fence: 1,
        payloadFingerprint: id,
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: index,
        resolvedAt: null,
        handoverRecorded: true,
        queuedMessageId: id
      })
    }
    const rows = projectStructuredAgentSessionMessages(items, [], submissions)
    let positionReads = 0
    for (const row of rows) {
      const position = row.journalPosition
      Object.defineProperty(row, 'journalPosition', {
        get: () => {
          positionReads++
          return position
        }
      })
    }
    let quotes = 0
    const startsWith = String.prototype.startsWith
    const spy = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
      this: string,
      prefix: string,
      position?: number
    ) {
      if (prefix[0] === '>' && prefix.endsWith('\n\n')) {
        quotes++
      }
      return startsWith.call(this, prefix, position)
    })
    try {
      const scan = scanPendingAsks(rows)
      expect(scan.contributors).toHaveLength(0)
      expect(quotes).toBe(count)
      expect(positionReads).toBeLessThan(40 * count)
      return { quotes, positionReads }
    } finally {
      spy.mockRestore()
    }
  }
  const normal = measure(1000)
  const large = measure(10000)
  expect(large.quotes).toBe(10 * normal.quotes)
  expect(large.positionReads).toBeLessThanOrEqual(11 * normal.positionReads)
})

it.each([false, true])(
  'accounts for accumulated questions and nonmatching handoffs (quoted: %s)',
  (quoted) => {
    function measure(count: number) {
      const items: AgentJournalRenderItem[] = []
      const submissions: AgentJournalSubmission[] = []
      for (let index = 0; index < count; index++) {
        const id = String(index)
        items.push({
          itemId: `ask-${id}`,
          sequence: index + 1,
          revision: 0,
          observedAt: index,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [
              {
                type: 'tool-call',
                name: 'request_user_input_async',
                callId: id,
                input: { questions: [{ title: `Question ${id}?`, options: ['Yes', 'No'] }] }
              }
            ]
          }
        })
        items.push({
          itemId: agentJournalSubmissionKey(id),
          sequence: count + index + 1,
          revision: 0,
          observedAt: index,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [
              { type: 'text', text: quoted ? '> A different question?\n\nYes' : 'Please continue' }
            ]
          }
        })
        submissions.push({
          clientMessageId: id,
          fence: 1,
          payloadFingerprint: id,
          dispatchState: 'pending',
          providerItemId: null,
          reason: null,
          submittedAt: index,
          resolvedAt: null,
          handoverRecorded: true,
          queuedMessageId: id
        })
      }
      items.sort((a, b) => a.sequence - b.sequence)
      const rows = projectStructuredAgentSessionMessages(items, [], submissions)
      let comparisons = 0
      const startsWith = String.prototype.startsWith
      const spy = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
        this: string,
        prefix: string,
        position?: number
      ) {
        if (prefix[0] === '>' && prefix.endsWith('\n\n')) {
          comparisons++
        }
        return startsWith.call(this, prefix, position)
      })
      try {
        const scan = scanPendingAsks(rows)
        expect(scan.contributors).toHaveLength(count)
        expect(scan.answerPending).toBe(true)
        // Quoted unmatched text retains the compatibility question × handoff matching bound.
        expect(comparisons).toBe(quoted ? count * count : 0)
        return comparisons
      } finally {
        spy.mockRestore()
      }
    }
    const normal = measure(30)
    const large = measure(300)
    expect(large).toBe(quoted ? 100 * normal : 0)
  }
)
