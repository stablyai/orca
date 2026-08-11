import { describe, expect, it } from 'vitest'
import {
  formatSenderLivenessAge,
  formatSenderLivenessLine,
  formatSenderLivenessTag,
  unknownSenderLiveness,
  type SenderLivenessEvidence
} from './orchestration-sender-liveness'

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

function working(overrides: Partial<SenderLivenessEvidence> = {}): SenderLivenessEvidence {
  return {
    state: 'working',
    source: 'agent_status',
    observedAt: new Date(NOW - 12_000).toISOString(),
    turnStartedAt: new Date(NOW - 3 * 60_000).toISOString(),
    paneKey: 'tab_worker:22222222-2222-4222-8222-222222222222',
    ...overrides
  }
}

describe('sender liveness rendering', () => {
  it('renders a live sender compactly on one banner line', () => {
    expect(
      formatSenderLivenessLine(working({ dispatch: { id: 'ctx_1', state: 'ready' } }), NOW)
    ).toBe('[Sender: working, turn 3m, seen 12s, via agent_status, dispatch ctx_1 ready]')
  })

  it('names the reason on the banner line when the verdict is unknown', () => {
    expect(
      formatSenderLivenessLine(
        unknownSenderLiveness('federated', { dispatch: { id: 'ctx_2', state: 'ready' } }),
        NOW
      )
    ).toBe('[Sender: unknown, via federated, dispatch ctx_2 ready]')
  })

  it('keeps the last observation on stale evidence', () => {
    const stale = unknownSenderLiveness('stale_agent_status', {
      observedAt: new Date(NOW - 45 * 60_000).toISOString()
    })
    expect(formatSenderLivenessLine(stale, NOW)).toBe(
      '[Sender: unknown, seen 45m, via stale_agent_status]'
    )
  })

  it('tags one-line listings and stays empty for hosts that send no evidence', () => {
    expect(formatSenderLivenessTag(working(), NOW)).toBe(' sender=working seen=12s')
    expect(formatSenderLivenessTag(unknownSenderLiveness('no_agent_status'), NOW)).toBe(
      ' sender=unknown(no_agent_status)'
    )
    expect(formatSenderLivenessTag(undefined, NOW)).toBe('')
  })

  it('scales the age unit and never reports a negative age', () => {
    expect(formatSenderLivenessAge(new Date(NOW - 900).toISOString(), NOW)).toBe('1s')
    expect(formatSenderLivenessAge(new Date(NOW - 90 * 60_000).toISOString(), NOW)).toBe('1h')
    expect(formatSenderLivenessAge(new Date(NOW - 50 * 60 * 60_000).toISOString(), NOW)).toBe('2d')
    expect(formatSenderLivenessAge(new Date(NOW + 5_000).toISOString(), NOW)).toBe('0s')
    expect(formatSenderLivenessAge('not-a-timestamp', NOW)).toBeNull()
    expect(formatSenderLivenessAge(null, NOW)).toBeNull()
  })
})
