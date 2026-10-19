import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { isHostMirroredSleepingRecord } from './host-mirrored-pane-liveness'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'

function outranks(
  record: SleepingAgentSessionRecord,
  current: SleepingAgentSessionRecord
): boolean {
  // Why: a host mirror may name a transcript its host still writes, so it speaks for the claim and a
  // newer native sibling for the same session is the duplicate (#29421).
  const mirrorRank =
    Number(isHostMirroredSleepingRecord(record)) - Number(isHostMirroredSleepingRecord(current))
  if (mirrorRank !== 0) {
    return mirrorRank > 0
  }
  return (
    record.capturedAt > current.capturedAt ||
    (record.capturedAt === current.capturedAt && record.updatedAt > current.updatedAt)
  )
}

/** The one record per provider-session claim key that the resume sweep acts on. */
export function getClaimRepresentativeRecords(
  records: readonly SleepingAgentSessionRecord[]
): Map<string, SleepingAgentSessionRecord> {
  const representatives = new Map<string, SleepingAgentSessionRecord>()
  for (const record of records) {
    const claimKey = getProviderSessionClaimKey(record)
    const current = representatives.get(claimKey)
    if (!current || outranks(record, current)) {
      representatives.set(claimKey, record)
    }
  }
  return representatives
}
