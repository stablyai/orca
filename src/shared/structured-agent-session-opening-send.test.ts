import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import {
  structuredAgentSessionSendOpeningTurn,
  type StructuredAgentSessionOpeningSendItem
} from './structured-agent-session-opening-send'

const send = {
  clientMessageId: 'send-1',
  dispatchState: 'pending',
  handedOverAt: 10,
  fence: 1
} as const
const handover: StructuredAgentSessionOpeningSendItem = {
  itemId: agentJournalSubmissionKey('send-1'),
  sequence: 5,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] },
  turnScope: { kind: 'thread' }
}
const turnRecord = (sequence: number): StructuredAgentSessionOpeningSendItem => ({
  itemId: `turn-${sequence}`,
  sequence,
  body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
})

function opening(items: StructuredAgentSessionOpeningSendItem[]): boolean {
  return structuredAgentSessionSendOpeningTurn([send], (visit) => items.forEach(visit), 1)
}

describe('a send still opening its turn', () => {
  it('holds the next message until a turn record follows its handover', () => {
    expect(opening([handover])).toBe(true)
    expect(opening([handover, turnRecord(6)])).toBe(false)
  })

  // A Stop the provider took before the turn opened withdraws the send: nothing is opening.
  it('ends once the send is settled, with no turn record', () => {
    const withdrawn = { ...send, dispatchState: 'rejected' } as const
    expect(structuredAgentSessionSendOpeningTurn([withdrawn], (visit) => visit(handover), 1)).toBe(
      false
    )
  })
})
