import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionOperationKey,
  evaluateAgentSessionOperation,
  type AgentSessionOperationRow
} from '../../../../shared/agent-session-operation-ledger'
import { agentSessionRefusalNotice } from '../../../../shared/agent-session-refusal-notice'
import { refuse } from '../../../../shared/agent-session-wire-refusals'
import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'

// 4:00 PM on the reader's own clock, whatever its time zone.
const NOW = new Date(2026, 9, 4, 16, 0).getTime()
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function operationId(timestamp: number, suffix: string): string {
  return `${String(timestamp).padStart(13, '0')}-${suffix.repeat(32)}`
}

function dayName(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  })
}

/** A full ledger (limit 2) and the refusal a third request meets, as it crosses the wire. */
function fullLedgerRefusal(ages: readonly [number, number] = [2 * HOUR, HOUR]) {
  const rows = new Map<string, AgentSessionOperationRow>()
  const placed: AgentSessionOperationRow[] = []
  for (const [at, suffix] of [
    [NOW - ages[0], 'b'],
    [NOW - ages[1], 'c']
  ] as const) {
    const decision = evaluateAgentSessionOperation({
      rows,
      callerKey: 'client-1',
      operationId: operationId(at, suffix),
      fingerprint: 'fp',
      now: at,
      perClientLimit: 2
    })
    if (decision.decision !== 'admit') {
      throw new Error(`expected admit, got ${decision.decision}`)
    }
    rows.set(agentSessionOperationKey('client-1', decision.row.operationId), decision.row)
    placed.push(decision.row)
  }
  const refused = evaluateAgentSessionOperation({
    rows,
    callerKey: 'client-1',
    operationId: operationId(NOW, 'd'),
    fingerprint: 'fp',
    now: NOW,
    perClientLimit: 2
  })
  if (refused.decision !== 'refused' || refused.code !== 'agent_session_operation_capacity') {
    throw new Error(`expected a capacity refusal, got ${refused.decision}`)
  }
  const wire: unknown = JSON.parse(
    JSON.stringify(refuse(refused.code, refused.details, 'Operation was refused.'))
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: built by `refuse` above and only round-tripped through JSON, as the wire does.
  const refusal = wire as Parameters<typeof agentSessionRefusalNotice>[0]
  return { refusal, oldest: placed[0], newest: placed[1] }
}

function capacityRefusal(capacityReturnsAt: number) {
  return {
    code: 'agent_session_operation_capacity' as const,
    message: 'capacity',
    details: { reason: 'operationCapacity' as const, capacityReturnsAt }
  }
}

const WITHOUT_TIME =
  'Orca has received too many requests in the last day. Your message was not sent.'

describe('the notice a full operation ledger gives', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says when Orca takes new requests again: when the oldest counted request ages out', () => {
    const { refusal, oldest, newest } = fullLedgerRefusal()
    const returnsAt = clockTime(oldest.expiresAt)
    expect(returnsAt).not.toBe(clockTime(newest.expiresAt))

    expect(agentSessionRefusalNotice(refusal, 'send')).toBe(
      `${WITHOUT_TIME} Orca can take new requests again tomorrow at ${returnsAt}.`
    )
    expect(agentSessionWriteFailureText(agentSessionRefusalFailure(refusal), 'send')).toBe(
      agentSessionRefusalNotice(refusal, 'send')
    )
  })

  it('names the day when a cap hit after a few hours of use frees up at an earlier clock time tomorrow', () => {
    // Requests from an hour and half an hour ago fill the cap at 4:00 PM; the first frees up at
    // 3:05 PM the next day, a clock time already past today.
    const { refusal, oldest } = fullLedgerRefusal([HOUR, HOUR / 2])
    expect(new Date(oldest.expiresAt).getDate()).toBe(new Date(NOW).getDate() + 1)
    expect(new Date(oldest.expiresAt).getHours()).toBe(15)
    expect(new Date(oldest.expiresAt).getMinutes()).toBe(5)

    const expected = `${WITHOUT_TIME} Orca can take new requests again tomorrow at ${clockTime(oldest.expiresAt)}.`
    expect(agentSessionRefusalNotice(refusal, 'send')).toBe(expected)
    expect(agentSessionWriteFailureText(agentSessionRefusalFailure(refusal), 'send')).toBe(expected)
  })

  it('names only the time when capacity returns later today', () => {
    // Requests from yesterday evening fill the cap; the first frees up at 7:05 PM today.
    const { refusal, oldest } = fullLedgerRefusal([21 * HOUR, 20 * HOUR])
    expect(new Date(oldest.expiresAt).getDate()).toBe(new Date(NOW).getDate())

    const expected = `${WITHOUT_TIME} Orca can take new requests again at ${clockTime(oldest.expiresAt)}.`
    expect(agentSessionRefusalNotice(refusal, 'send')).toBe(expected)
    expect(agentSessionWriteFailureText(agentSessionRefusalFailure(refusal), 'send')).toBe(expected)
  })

  it('names the date when capacity returns later than tomorrow, as a skewed clock can make it', () => {
    const at = NOW + 50 * HOUR
    const refusal = capacityRefusal(at)
    const expected = `${WITHOUT_TIME} Orca can take new requests again on ${dayName(at)} at ${clockTime(at)}.`
    expect(agentSessionRefusalNotice(refusal, 'send')).toBe(expected)
    expect(agentSessionWriteFailureText(agentSessionRefusalFailure(refusal), 'send')).toBe(expected)
  })

  it('rounds up to the minute, so the time shown is never before capacity returns', () => {
    const minute = NOW + 2 * HOUR
    expect(agentSessionRefusalNotice(capacityRefusal(minute + 1), 'send')).toBe(
      `${WITHOUT_TIME} Orca can take new requests again at ${clockTime(minute + MINUTE)}.`
    )
  })

  it('drops the time once it has passed, as on a saved refusal shown again later', () => {
    for (const at of [NOW - HOUR, NOW]) {
      const refusal = capacityRefusal(at)
      expect(agentSessionRefusalNotice(refusal, 'send')).toBe(WITHOUT_TIME)
      expect(agentSessionWriteFailureText(agentSessionRefusalFailure(refusal), 'send')).toBe(
        WITHOUT_TIME
      )
    }
  })

  it('names tomorrow for a return in the last minute of today, which rounds up to midnight', () => {
    const midnight = new Date(2026, 9, 5, 0, 0).getTime()
    // 11:59:30 PM today is shown as 12:00 AM, which is tomorrow, not the midnight just past.
    expect(
      agentSessionRefusalNotice(capacityRefusal(new Date(2026, 9, 4, 23, 59, 30).getTime()), 'send')
    ).toBe(`${WITHOUT_TIME} Orca can take new requests again tomorrow at ${clockTime(midnight)}.`)
  })

  it("compares the reader's local days, not UTC days", () => {
    // Pinned here because CI runs in UTC, where both agree.
    const runnerZone = process.env.TZ
    try {
      for (const zone of ['Pacific/Kiritimati', 'Pacific/Honolulu']) {
        process.env.TZ = zone
        const now = new Date(2026, 9, 4, 16, 0).getTime()
        vi.setSystemTime(now)
        const tomorrowMorning = new Date(2026, 9, 5, 9, 0).getTime()
        // In both zones 9:00 AM tomorrow falls on the same UTC date as 4:00 PM today.
        expect(new Date(tomorrowMorning).getUTCDate()).toBe(new Date(now).getUTCDate())

        expect(agentSessionRefusalNotice(capacityRefusal(tomorrowMorning), 'send')).toBe(
          `${WITHOUT_TIME} Orca can take new requests again tomorrow at ${clockTime(tomorrowMorning)}.`
        )
      }
    } finally {
      if (runnerZone === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = runnerZone
      }
    }
  })

  it('keeps the words it had when a refusal carries no time', () => {
    expect(
      agentSessionRefusalNotice(
        {
          code: 'agent_session_operation_capacity',
          message: 'capacity',
          details: { reason: 'operationCapacity' }
        },
        'answer'
      )
    ).toBe('Orca has received too many requests in the last day. Your answer was not sent.')
  })
})
