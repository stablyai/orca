// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  hasUndeliveredStructuredAgentSessionOutbox,
  resetUndeliveredStructuredAgentSessionOutboxForTests,
  subscribeToUndeliveredStructuredAgentSessionOutbox,
  writeOutbox
} from './structured-agent-session-outbox-storage'

function entry(sessionId: string, clientMessageId: string) {
  return createStructuredAgentSessionOutboxEntry({
    clientMessageId,
    sessionId,
    text: clientMessageId,
    attachments: [],
    queuedAt: 1
  })
}

describe('undelivered structured agent session outbox projection', () => {
  beforeEach(() => {
    localStorage.clear()
    resetUndeliveredStructuredAgentSessionOutboxForTests()
  })

  it('reports a session whose outbox was persisted before this renderer read it', () => {
    writeOutbox('session-a', [entry('session-a', 'client-1')])
    resetUndeliveredStructuredAgentSessionOutboxForTests()

    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(true)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-b')).toBe(false)
  })

  it('notifies when the first entry lands and when the last one leaves', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox(listener)

    writeOutbox('session-a', [entry('session-a', 'client-1')])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(true)

    writeOutbox('session-a', [])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false)

    unsubscribe()
    writeOutbox('session-a', [entry('session-a', 'client-2')])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stays quiet for a write that leaves the session undelivered either way', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox(listener)

    writeOutbox('session-a', [entry('session-a', 'client-1'), entry('session-a', 'client-2')])
    expect(listener).toHaveBeenCalledTimes(1)

    writeOutbox('session-a', [entry('session-a', 'client-2')])
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})
