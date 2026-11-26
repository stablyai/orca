import {
  isRemoteForegroundEvidence,
  type RemoteForegroundEvidence
} from './foreground-process-evidence'

/** Maximum host-observation age accepted by a renderer foreground sample. */
export const REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS = 2_000

export type RemoteForegroundEvidenceAdmission = {
  expectedPtyId: string
  expectedIncarnationId: string | null
  requestStartedAtMonotonic: number
  receivedAtMonotonic: number
  lastAuthorityGeneration: string | null
  lastObservationEpoch: number
  /** Generations already accepted for this PTY binding; rejects delayed old-host replies. */
  knownAuthorityGenerations?: ReadonlySet<string>
}

/** Require current PTY-incarnation host evidence; transport failures supply undefined, never synthetic host records. */
export function admitRemoteForegroundEvidence(
  value: unknown,
  admission: RemoteForegroundEvidenceAdmission
): RemoteForegroundEvidence | null {
  if (!isRemoteForegroundEvidence(value)) {
    return null
  }
  if (
    admission.expectedIncarnationId === null ||
    value.ptyId !== admission.expectedPtyId ||
    value.ptyIncarnationId !== admission.expectedIncarnationId
  ) {
    return null
  }
  const receiveDelay = Math.max(
    0,
    admission.receivedAtMonotonic - admission.requestStartedAtMonotonic
  )
  // Use max, never sum: ps duration is inside receiveDelay and also included in host capturedAgeMs. Summing charged capture twice
  // (1200ms host + 1300ms round trip falsely exceeded 2s). Sweep gates differ: post-listing planning time is nonoverlapping and additive.
  if (Math.max(value.capturedAgeMs, receiveDelay) > REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS) {
    return null
  }
  if (
    admission.knownAuthorityGenerations?.has(value.authorityGeneration) &&
    admission.lastAuthorityGeneration !== value.authorityGeneration
  ) {
    return null
  }
  if (
    admission.lastAuthorityGeneration === value.authorityGeneration &&
    value.observationEpoch <= admission.lastObservationEpoch
  ) {
    return null
  }
  return value
}
