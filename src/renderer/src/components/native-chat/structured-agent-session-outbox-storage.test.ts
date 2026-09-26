// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionAttemptFailure
} from '../../../../shared/structured-agent-session-outbox'
import {
  hasUndeliveredStructuredAgentSessionOutbox,
  readOutbox,
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
    const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', listener)

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
    const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', listener)

    writeOutbox('session-a', [entry('session-a', 'client-1'), entry('session-a', 'client-2')])
    expect(listener).toHaveBeenCalledTimes(1)

    writeOutbox('session-a', [entry('session-a', 'client-2')])
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
  it('does not notify a session subscriber for another session', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', listener)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false)
    writeOutbox('session-b', [entry('session-b', 'client-1')])
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('releases the cached snapshot when the last subscriber leaves', () => {
    writeOutbox('session-a', [entry('session-a', 'client-1')])
    const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', vi.fn())
    const getItem = vi.spyOn(localStorage, 'getItem')
    for (let index = 0; index < 10; index += 1) {
      expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(true)
    }
    expect(getItem).not.toHaveBeenCalled()
    unsubscribe()
    localStorage.clear()
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false)
    getItem.mockRestore()
  })

  it('keeps a snapshot until both subscribers leave and reloads it on remount', () => {
    const first = vi.fn()
    const second = vi.fn()
    const releaseFirst = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', first)
    const releaseSecond = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', second)
    releaseFirst()
    writeOutbox('session-a', [entry('session-a', 'client-1')])
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    releaseSecond()
    localStorage.clear()
    const releaseRemount = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', first)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false)
    writeOutbox('session-a', [entry('session-a', 'client-2')])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    releaseRemount()
  })
})

describe("a saved message's last failure", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it.each<StructuredAgentSessionAttemptFailure>([
    { kind: 'refused', code: 'agent_session_checkpoint_stale' },
    { kind: 'rejected', reason: 'Claude messages support at most 20 images' },
    { kind: 'rejected', reason: null },
    { kind: 'failed' }
  ])('reads back $kind as it was saved', (lastFailure) => {
    writeOutbox('session-a', [{ ...entry('session-a', 'client-1'), lastFailure }])

    expect(readOutbox('session-a')[0]?.lastFailure).toEqual(lastFailure)
  })

  it('keeps the message and drops a failure it cannot read', () => {
    localStorage.setItem(
      'orca:desktopStructuredAgentSessionOutbox:v1:session-a',
      JSON.stringify([
        { ...entry('session-a', 'client-1'), lastFailure: 'The agent was restarting.' },
        { ...entry('session-a', 'client-2'), lastFailure: { kind: 'rejected', reason: 7 } }
      ])
    )

    const read = readOutbox('session-a')
    expect(read.map((saved) => saved.clientMessageId)).toEqual(['client-1', 'client-2'])
    expect(read.every((saved) => saved.lastFailure === undefined)).toBe(true)
  })
})
