import { describe, expect, it } from 'vitest'
import { isExactAutomationRunCompletionAttribution } from '../../../shared/automation-run-completion-attribution'
import {
  buildAutomationRunCompletionAttribution,
  createAutomationAgentSessionTracker,
  noteAutomationAgentStatus,
  resolveAutomationAgentSessionFingerprint,
  resolveAutomationRunUsageProvider
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

  it('does not bind fingerprint from blocked or waiting', () => {
    const tracker = createAutomationAgentSessionTracker()

    expect(
      noteAutomationAgentStatus(tracker, {
        state: 'blocked',
        providerSession: { key: 'session_id', id: 'nested-blocked' }
      })
    ).toBe(false)
    expect(tracker.boundFingerprint).toBeNull()
    expect(tracker.sawWorkingAfterStart).toBe(false)

    expect(
      noteAutomationAgentStatus(tracker, {
        state: 'waiting',
        providerSession: { key: 'session_id', id: 'nested-waiting' }
      })
    ).toBe(false)
    expect(tracker.boundFingerprint).toBeNull()
    expect(tracker.sawWorkingAfterStart).toBe(false)

    noteAutomationAgentStatus(tracker, {
      state: 'working',
      providerSession: { key: 'session_id', id: 'primary' }
    })
    expect(tracker.boundFingerprint).toBe('session_id:primary')
  })

  it('does not let waiting count as the reuse working edge', () => {
    const tracker = createAutomationAgentSessionTracker()
    const options = { requireWorkingAfterStart: true }

    expect(noteAutomationAgentStatus(tracker, { state: 'waiting' }, options)).toBe(false)
    expect(tracker.sawWorkingAfterStart).toBe(false)
    expect(noteAutomationAgentStatus(tracker, { state: 'done' }, options)).toBe(false)

    expect(noteAutomationAgentStatus(tracker, { state: 'working' }, options)).toBe(false)
    expect(tracker.sawWorkingAfterStart).toBe(true)
    expect(noteAutomationAgentStatus(tracker, { state: 'done' }, options)).toBe(true)
  })

  it('ignores fingerprint-bearing done before any working bind', () => {
    const tracker = createAutomationAgentSessionTracker()

    expect(
      noteAutomationAgentStatus(tracker, {
        state: 'done',
        providerSession: { key: 'session_id', id: 'nested-only-done' }
      })
    ).toBe(false)
    expect(tracker.boundFingerprint).toBeNull()

    noteAutomationAgentStatus(tracker, {
      state: 'working',
      providerSession: { key: 'session_id', id: 'primary' }
    })
    expect(
      noteAutomationAgentStatus(tracker, {
        state: 'done',
        providerSession: { key: 'session_id', id: 'nested-only-done' }
      })
    ).toBe(false)
    expect(
      noteAutomationAgentStatus(tracker, {
        state: 'done',
        providerSession: { key: 'session_id', id: 'primary' }
      })
    ).toBe(true)
  })
})

describe('buildAutomationRunCompletionAttribution', () => {
  it('emits a positive exact receipt only after a provider session is bound', () => {
    const tracker = createAutomationAgentSessionTracker()
    const fallback = buildAutomationRunCompletionAttribution({
      tracker,
      provider: resolveAutomationRunUsageProvider('claude'),
      terminalPtyId: 'pty-1',
      terminalPaneKey: 'pane-1'
    })
    expect(fallback.kind).toBe('pane_time_fallback')
    expect(isExactAutomationRunCompletionAttribution(fallback)).toBe(false)

    noteAutomationAgentStatus(tracker, {
      state: 'working',
      providerSession: { key: 'session_id', id: 'primary-session' }
    })
    expect(
      buildAutomationRunCompletionAttribution({
        tracker,
        provider: 'claude',
        terminalPtyId: 'pty-1',
        terminalPaneKey: 'pane-1'
      }).kind
    ).toBe('pane_time_fallback')
    noteAutomationAgentStatus(tracker, {
      state: 'done',
      providerSession: { key: 'session_id', id: 'primary-session' }
    })
    const exact = buildAutomationRunCompletionAttribution({
      tracker,
      provider: 'claude',
      terminalPtyId: 'pty-1',
      terminalPaneKey: 'pane-1'
    })
    expect(exact).toEqual({
      kind: 'exact_provider_session',
      provider: 'claude',
      providerSessionKey: 'session_id',
      providerSessionId: 'primary-session',
      terminalPtyId: 'pty-1',
      terminalPaneKey: 'pane-1'
    })
    expect(isExactAutomationRunCompletionAttribution(exact)).toBe(true)
  })

  it('does not treat usage time-window fallback as exact attribution', () => {
    expect(
      isExactAutomationRunCompletionAttribution({
        kind: 'pane_time_fallback',
        provider: 'claude',
        providerSessionKey: 'session_id',
        providerSessionId: 'sess',
        terminalPtyId: 'pty-1',
        terminalPaneKey: 'pane-1'
      })
    ).toBe(false)
  })
})
