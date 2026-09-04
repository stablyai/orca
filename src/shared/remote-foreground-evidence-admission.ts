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

/**
 * Admit only a host record tied to the currently attached PTY incarnation.
 * Transport failures intentionally pass `undefined` and produce no synthetic
 * host record.
 */
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
  if (value.capturedAgeMs + receiveDelay > REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS) {
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
