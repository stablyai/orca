import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../requests/agent-session-queued-message-wire'
import * as subjects from '../../../orchestration/mailbox/reply-subject'
import {
  projectQueuedMessageCards,
  queuedMessageCardLine
} from '../structured-agent-session-queued-cards'
import {
  composerQueuedCards,
  createWaitingAgentMailRows
} from '../structured-agent-session-waiting-agent-mail'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

afterEach(() => {
  vi.restoreAllMocks()
})

function queuedMail(position: number, title: string): AgentSessionQueuedMessage {
  const subject = `${'Re: '.repeat(42)}${title}`
  const messageId = `message-${position}`
  return {
    messageId,
    position,
    state: 'waiting',
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: subject }],
      from: {
        kind: 'agent',
        senders: [],
        orchestration: {
          message: 'mail-notice',
          mailbox: 'recipient',
          dispatchId: null,
          messages: [
            { messageId, runId: 'run', from: 'worker', content: { subject: [0, subject.length] } }
          ]
        }
      }
    }
  }
}

// PR #49879: full queue frames must not normalize hidden cards or rescan unchanged visible mail.
it.each([10, 100])('does not reformat unchanged mail in a queue of %i', (count) => {
  const formatSubject = vi.spyOn(subjects, 'collapseRepeatedReplyPrefixes')
  let state: StructuredAgentSessionState = { ...EMPTY_STRUCTURED_AGENT_SESSION, epoch: 'epoch' }
  let sequence = 0
  const waitingRows = createWaitingAgentMailRows()
  const publish = (messages: AgentSessionQueuedMessage[], paused: boolean) => {
    state = reduceStructuredAgentSession(
      state,
      {
        type: 'event',
        event: {
          type: 'batch',
          sessionId: 'test',
          batch: {
            cursor: { epoch: 'epoch', sequence: ++sequence },
            items: [],
            removedItemIds: [],
            submissions: []
          },
          queuedMessages: structuredClone(messages),
          queuePause: paused ? { reason: 'failed' } : null
        }
      },
      sequence
    )
    const cards = projectQueuedMessageCards(state.queuedMessages, state.submissions, {
      queuePaused: paused
    })
    const waiting = paused ? [] : waitingRows(state.queuedMessages, state.submissions)
    return composerQueuedCards(cards, waiting, undefined).cards.map((card) =>
      queuedMessageCardLine(card)
    )
  }
  const messages = Array.from({ length: count }, (_, position) =>
    queuedMail(position, 'Build review')
  )
  const changed = [queuedMail(0, 'Release notes'), ...messages.slice(1)]

  expect(publish(messages, false)).toEqual([])
  expect(formatSubject).not.toHaveBeenCalled()
  expect(publish(messages, true)).toEqual(Array<string>(count).fill('Re: Build review'))
  expect(formatSubject).toHaveBeenCalledTimes(count)
  formatSubject.mockClear()

  expect(publish(changed, true)[0]).toBe('Re: Release notes')
  expect(formatSubject).toHaveBeenCalledTimes(1)
  formatSubject.mockClear()
  const newMessage = queuedMail(count, 'Follow-up')
  expect(publish([...changed, newMessage], true).at(-1)).toBe('Re: Follow-up')
  expect(formatSubject).toHaveBeenCalledTimes(1)
  formatSubject.mockClear()

  expect(publish(changed, true)).toHaveLength(count)
  expect(formatSubject).not.toHaveBeenCalled()
  expect(publish(changed, false)).toEqual([])
  expect(formatSubject).not.toHaveBeenCalled()
  expect(publish(changed, true)[0]).toBe('Re: Release notes')
  expect(formatSubject).not.toHaveBeenCalled()
})
