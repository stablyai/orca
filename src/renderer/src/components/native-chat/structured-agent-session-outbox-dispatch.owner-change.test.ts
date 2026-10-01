// An owner change sends a send left dispatching again under its id. One a Stop outlived is put
// back the same way, and its mark alone holds it: the drain never admits it.

import { describe, expect, it } from 'vitest'
import {
  admitStructuredAgentSessionOutboxEntry,
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { requeueInterruptedStructuredAgentSessionDispatches } from './structured-agent-session-outbox-dispatch'

function dispatching(
  clientMessageId: string,
  overrides: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId: 'session-1',
      text: clientMessageId,
      attachments: [],
      queuedAt: 1
    }),
    state: 'dispatching',
    lastAttemptAt: 2,
    ...overrides
  }
}

describe('requeue after an owner change', () => {
  it('resends an interrupted send, but never one a Stop outlived', () => {
    const [stopped] = requeueInterruptedStructuredAgentSessionDispatches(
      [dispatching('stopped', { outlivedStop: true })],
      1
    )
    expect(admitStructuredAgentSessionOutboxEntry([stopped], null).state).toBe('blocked')
    const [plain] = requeueInterruptedStructuredAgentSessionDispatches([dispatching('plain')], 1)
    expect(admitStructuredAgentSessionOutboxEntry([plain], null).state).toBe('dispatch')
  })
})
