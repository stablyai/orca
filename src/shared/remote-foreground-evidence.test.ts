import { describe, expect, it } from 'vitest'
import { isRemoteForegroundEvidence } from './foreground-process-evidence'
import {
  admitRemoteForegroundEvidence,
  REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS
} from './remote-foreground-evidence-admission'

const live = {
  verdict: 'live' as const,
  processName: 'codex',
  authorityGeneration: 'host-a',
  observationEpoch: 4,
  capturedAgeMs: 5,
  ptyId: 'pty-1',
  ptyIncarnationId: 'inc-1',
  fence: {
    platform: 'posix' as const,
    shellPid: 10,
    shellStartTime: '100',
    tty: '/dev/pts/2',
    foregroundPgid: 11,
    process: { pid: 11, startTime: '101' }
  }
}

describe('remote foreground evidence contract', () => {
  it.each([
    live,
    { ...live, verdict: 'unverifiable' as const, reason: 'process_table_unreadable' },
    { ...live, verdict: 'exited' as const, reason: 'pty_exit_0' }
  ])('accepts the $verdict host record', (value) => {
    expect(isRemoteForegroundEvidence(value)).toBe(true)
  })

  it.each([
    { ...live, authorityGeneration: '' },
    { ...live, ptyIncarnationId: '' },
    { ...live, capturedAgeMs: -1 },
    { ...live, fence: { ...live.fence, shellStartTime: '' } },
    { ...live, fence: { ...live.fence, process: { pid: 11, startTime: '' } } },
    { ...live, verdict: 'exited' as const, reason: '' }
  ])('rejects an unfenced or malformed host record', (value) => {
    expect(isRemoteForegroundEvidence(value)).toBe(false)
  })

  it('admits only the current incarnation, fresh age, and increasing host epoch', () => {
    const base = {
      expectedPtyId: 'pty-1',
      expectedIncarnationId: 'inc-1',
      requestStartedAtMonotonic: 100,
      receivedAtMonotonic: 110,
      lastAuthorityGeneration: 'host-a',
      lastObservationEpoch: 3
    }
    expect(admitRemoteForegroundEvidence(live, base)).toEqual(live)
    expect(
      admitRemoteForegroundEvidence(live, { ...base, lastObservationEpoch: live.observationEpoch })
    ).toBeNull()
    expect(
      admitRemoteForegroundEvidence(live, { ...base, expectedIncarnationId: 'inc-2' })
    ).toBeNull()
    expect(
      admitRemoteForegroundEvidence(
        { ...live, capturedAgeMs: REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS },
        base
      )
    ).toBeNull()
  })

  it('rejects delayed observations from a previously accepted host generation', () => {
    const knownAuthorityGenerations = new Set(['host-a', 'host-b'])
    const admission = {
      expectedPtyId: 'pty-1',
      expectedIncarnationId: 'inc-1',
      requestStartedAtMonotonic: 100,
      receivedAtMonotonic: 110,
      lastAuthorityGeneration: 'host-b',
      lastObservationEpoch: 1,
      knownAuthorityGenerations
    }
    expect(
      admitRemoteForegroundEvidence({ ...live, authorityGeneration: 'host-a' }, admission)
    ).toBeNull()
  })
})
