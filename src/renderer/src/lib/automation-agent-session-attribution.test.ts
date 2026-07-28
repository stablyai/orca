import { describe, expect, it } from 'vitest'
import {
  createAutomationAgentSessionTracker,
  noteAutomationAgentStatus,
  resolveAutomationAgentSessionFingerprint
} from './automation-agent-session-attribution'

describe('resolveAutomationAgentSessionFingerprint', () => {
  it('builds a stable key from provider session metadata', () => {
    expect(
      resolveAutomationAgentSessionFingerprint({
        providerSession: { key: 'session_id', id: 'sess-primary' }
      })
    ).toBe('session_id:sess-primary')
    expect(
      resolveAutomationAgentSessionFingerprint({
        providerSession: { key: 'conversation_id', id: 'conv-1' }
      })
    ).toBe('conversation_id:conv-1')
  })

  it('returns null when session id is missing', () => {
    expect(resolveAutomationAgentSessionFingerprint({})).toBeNull()
    expect(
      resolveAutomationAgentSessionFingerprint({
        providerSession: { key: 'session_id', id: '   ' }
      })
    ).toBeNull()
  })
})

describe('noteAutomationAgentStatus', () => {
  it('ignores nested done on the same pane with a different session', () => {
    const tracker = createAutomationAgentSessionTracker()

    expect(
      noteAutomationAgentStatus(tracker, {
        state: 'working',
        providerSession: { key: 'session_id', id: 'primary' }
      })
    ).toBe(false)
    expect(tracker.boundFingerprint).toBe('session_id:primary')

    expect(
      noteAutomationAgentStatus(tracker, {
        state: 'working',
        providerSession: { key: 'session_id', id: 'nested' }
      })
    ).toBe(false)
    expect(tracker.boundFingerprint).toBe('session_id:primary')

    expect(
      noteAutomationAgentStatus(tracker, {
        state: 'done',
        providerSession: { key: 'session_id', id: 'nested' }
      })
    ).toBe(false)
  })

  it('finalizes only when the bound primary session reports done', () => {
    const tracker = createAutomationAgentSessionTracker()

    noteAutomationAgentStatus(tracker, {
      state: 'working',
      providerSession: { key: 'session_id', id: 'primary' }
    })
    noteAutomationAgentStatus(tracker, {
      state: 'done',
      providerSession: { key: 'session_id', id: 'nested' }
    })

    expect(
      noteAutomationAgentStatus(tracker, {
        state: 'done',
        providerSession: { key: 'session_id', id: 'primary' }
      })
    ).toBe(true)
  })

  it('keeps paneKey-only behavior when no provider session is available', () => {
    const tracker = createAutomationAgentSessionTracker()

    expect(noteAutomationAgentStatus(tracker, { state: 'working' })).toBe(false)
    expect(tracker.boundFingerprint).toBeNull()
    expect(noteAutomationAgentStatus(tracker, { state: 'done' })).toBe(true)
  })

  it('requires working after start when requested (reuse path)', () => {
    const tracker = createAutomationAgentSessionTracker()
    const options = { requireWorkingAfterStart: true }

    expect(
      noteAutomationAgentStatus(
        tracker,
        {
          state: 'done',
          providerSession: { key: 'session_id', id: 'primary' }
        },
        options
      )
    ).toBe(false)

    noteAutomationAgentStatus(
      tracker,
      {
        state: 'working',
        providerSession: { key: 'session_id', id: 'primary' }
      },
      options
    )

    expect(
      noteAutomationAgentStatus(
        tracker,
        {
          state: 'done',
          providerSession: { key: 'session_id', id: 'primary' }
        },
        options
      )
    ).toBe(true)
  })

  it('ignores unscoped done once a primary session was bound', () => {
    const tracker = createAutomationAgentSessionTracker()
    noteAutomationAgentStatus(tracker, {
      state: 'working',
      providerSession: { key: 'session_id', id: 'primary' }
    })

    expect(noteAutomationAgentStatus(tracker, { state: 'done' })).toBe(false)
  })
})
