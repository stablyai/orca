import { describe, expect, it } from 'vitest'
import {
  MAX_RELAY_PTY_REVIVE_FIELD_BYTES,
  normalizeRelayPtyLostEntry,
  normalizeRelayPtyRevivedEntry
} from './pty-revive-outcome-fields'
import { normalizeRelayPtyReviveOutcome } from './pty-revive-outcome-normalization'
import { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS } from './terminal-size-limits'

function lostEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pty-1',
    kind: 'ordinary-shell',
    reason: 'process-not-running',
    pid: 42,
    cols: 80,
    rows: 24,
    cwd: '/repo',
    ...overrides
  }
}

function owner(ptyId = 'pty-1'): Record<string, unknown> {
  return {
    claim: {
      digestVersion: 1,
      keyId: 'claim-key',
      identityDigest: 'a'.repeat(43),
      worktreeScopeDigest: 'b'.repeat(43),
      agent: 'codex'
    },
    generation: 'generation-1',
    phase: 'live',
    ptyId,
    surface: {
      worktreeId: 'repo::/repo',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      terminalHandle: 'term_abc123'
    }
  }
}

describe('relay PTY revive outcome normalization', () => {
  it('accepts typed strings at the field byte limit and rejects one byte over', () => {
    const field = 'x'.repeat(MAX_RELAY_PTY_REVIVE_FIELD_BYTES)

    expect(() => normalizeRelayPtyLostEntry(lostEntry({ cwd: field }))).not.toThrow()
    expect(() =>
      normalizeRelayPtyLostEntry(lostEntry({ durableLaunch: { startupCommand: field } }))
    ).not.toThrow()
    expect(() =>
      normalizeRelayPtyRevivedEntry({
        id: 'pty-1',
        disposition: 'already-managed',
        incarnationId: field
      })
    ).not.toThrow()
    expect(() => normalizeRelayPtyLostEntry(lostEntry({ cwd: `${field}x` }))).toThrow(
      'PTY revive lost entry cwd is invalid'
    )
    expect(() =>
      normalizeRelayPtyLostEntry(lostEntry({ durableLaunch: { startupCommand: `${field}x` } }))
    ).toThrow('PTY revive durable launch startupCommand is invalid')
    expect(() =>
      normalizeRelayPtyRevivedEntry({
        id: 'pty-1',
        disposition: 'already-managed',
        incarnationId: `${field}x`
      })
    ).toThrow('PTY revive revived entry incarnationId is invalid')
  })

  it('uses terminal dimension admission limits for typed lost entries', () => {
    expect(() =>
      normalizeRelayPtyLostEntry(lostEntry({ cols: MAX_TERMINAL_COLS, rows: MAX_TERMINAL_ROWS }))
    ).not.toThrow()
    expect(() => normalizeRelayPtyLostEntry(lostEntry({ cols: MAX_TERMINAL_COLS + 1 }))).toThrow(
      `1 through ${MAX_TERMINAL_COLS}`
    )
    expect(() => normalizeRelayPtyLostEntry(lostEntry({ rows: Number.MAX_SAFE_INTEGER }))).toThrow(
      `1 through ${MAX_TERMINAL_ROWS}`
    )
  })

  it('keeps the replay-tail-specific 100 KiB allowance', () => {
    const tail = 'x'.repeat(100 * 1024)

    expect(() =>
      normalizeRelayPtyLostEntry(
        lostEntry({
          replayTail: { data: tail, encoding: 'utf8', byteLength: tail.length, truncated: false }
        })
      )
    ).not.toThrow()
    expect(() =>
      normalizeRelayPtyLostEntry(
        lostEntry({
          replayTail: {
            data: `${tail}x`,
            encoding: 'utf8',
            byteLength: tail.length + 1,
            truncated: false
          }
        })
      )
    ).toThrow('PTY revive replay tail data is invalid')
  })

  it('fails closed on unknown provider-session and nested owner fields', () => {
    const outcome = (entry: Record<string, unknown>) =>
      normalizeRelayPtyReviveOutcome({
        outcomeVersion: 1,
        revived: [],
        lost: [entry],
        diagnostics: []
      })

    expect(() =>
      outcome(
        lostEntry({ providerSession: { key: 'session_id', id: 'session-1', prompt: 'private' } })
      )
    ).toThrow('unknown field')
    expect(() =>
      outcome(
        lostEntry({
          agentOwners: [
            {
              ...owner(),
              surface: { ...(owner().surface as Record<string, unknown>), hook: 'private' }
            }
          ]
        })
      )
    ).toThrow('unknown field')
    expect(() => outcome(lostEntry({ agentOwners: [owner('pty-other')] }))).toThrow(
      'agent owner is invalid'
    )
  })
})
