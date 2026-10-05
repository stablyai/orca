import { describe, expect, it } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionSubscribeEvent } from './agent-session-wire'
import type { NativeChatAsyncQuestionsField } from './native-chat-async-questions'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

const page: AgentSessionHistoryPage = {
  sessionId: 's',
  epoch: 'e',
  direction: 'tail',
  items: [],
  removedItemIds: [],
  submissions: [],
  window: { oldest: null, newest: null, nextCursor: { epoch: 'e', sequence: 0 } },
  liveCursor: { epoch: 'e', sequence: 1 },
  hasOlder: false,
  hasNewer: false
}
const ready = (title: string): NativeChatAsyncQuestionsField => ({
  state: 'ready',
  questions: [{ key: title, index: 0, title }]
})
const snapshot = (asyncQuestions?: NativeChatAsyncQuestionsField): AgentSessionSubscribeEvent => ({
  type: 'snapshot',
  sessionId: 's',
  page,
  fence: 1,
  ...(asyncQuestions ? { asyncQuestions } : {})
})
const batch = (
  sequence: number,
  asyncQuestions?: NativeChatAsyncQuestionsField
): Extract<AgentSessionSubscribeEvent, { type: 'batch' }> => ({
  type: 'batch',
  sessionId: 's',
  batch: { cursor: { epoch: 'e', sequence }, items: [], removedItemIds: [], submissions: [] },
  ...(asyncQuestions ? { asyncQuestions } : {})
})
const apply = (
  state: StructuredAgentSessionState,
  event: AgentSessionSubscribeEvent
): StructuredAgentSessionState => reduceStructuredAgentSession(state, { type: 'event', event })

describe('async questions in the structured session reducer', () => {
  it('takes the set whole from a snapshot and keeps it across batches that omit it', () => {
    const hydrated = apply(EMPTY_STRUCTURED_AGENT_SESSION, snapshot(ready('A?')))
    expect(hydrated.asyncQuestions).toEqual(ready('A?'))
    expect(apply(hydrated, batch(2)).asyncQuestions).toEqual(ready('A?'))
    expect(apply(hydrated, batch(1, ready('B?'))).asyncQuestions).toEqual(ready('B?'))
  })

  it('reads a snapshot without the field (older host) as absent', () => {
    const hydrated = apply(EMPTY_STRUCTURED_AGENT_SESSION, snapshot(ready('A?')))
    expect(apply(hydrated, snapshot()).asyncQuestions).toBeUndefined()
  })

  it('keeps the latest set when coalescing batches', () => {
    const merge = (
      left: AgentSessionSubscribeEvent,
      right: AgentSessionSubscribeEvent
    ): AgentSessionSubscribeEvent | undefined => {
      const emitted: AgentSessionSubscribeEvent[] = []
      const coalescer = createStructuredAgentSessionEventCoalescer((event) => emitted.push(event))
      coalescer.push(left)
      coalescer.push(right)
      coalescer.flush()
      return emitted[0]
    }
    expect(merge(batch(2, ready('A?')), batch(3))).toMatchObject({ asyncQuestions: ready('A?') })
    expect(merge(batch(2, ready('A?')), batch(3, ready('B?')))).toMatchObject({
      asyncQuestions: ready('B?')
    })
  })
})
