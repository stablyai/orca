export type CrossPlaneIdentityLink = {
  orcaIdentity: string
  externalPlane: string
  externalIdentity: string
  linkedBy: 'neutral_coordinator'
  evidenceId: string
}

export type CrossPlaneAckEvidence = {
  messageId: string
  sequence: number
  threadId: string
  correlationId: string
  senderEpoch: string
  receiverEpoch: string
  ackMessageId?: string
  ackSequence?: number
  ackReadBack: boolean
  ackCorrelationId?: string
  ackSenderEpoch?: string
  ackReceiverEpoch?: string
  completionReceiptId?: string
  nativeCompletionQueryBack: boolean
  nativeCompletionCorrelationId?: string
  identityLink: CrossPlaneIdentityLink
}

export type CrossPlaneDeliveryState = 'accepted' | 'prompt_delivered' | 'completion_verified'

export type CrossPlaneAckVerdict = {
  state: CrossPlaneDeliveryState
  verified: boolean
  effectsApplied: false
  missing: string[]
}

function baseEvidenceMissing(evidence: CrossPlaneAckEvidence): string[] {
  const required = [
    ['messageId', evidence.messageId],
    ['threadId', evidence.threadId],
    ['correlationId', evidence.correlationId],
    ['senderEpoch', evidence.senderEpoch],
    ['receiverEpoch', evidence.receiverEpoch],
    ['identityLink.evidenceId', evidence.identityLink.evidenceId],
    ['identityLink.orcaIdentity', evidence.identityLink.orcaIdentity],
    ['identityLink.externalPlane', evidence.identityLink.externalPlane],
    ['identityLink.externalIdentity', evidence.identityLink.externalIdentity]
  ] as const
  return required.filter(([, value]) => !value.trim()).map(([name]) => name)
}

/** Verifies evidence only; it never sends, acknowledges, completes, or mutates a Dispatch. */
export function verifyCrossPlaneAck(evidence: CrossPlaneAckEvidence): CrossPlaneAckVerdict {
  const missing = baseEvidenceMissing(evidence)
  if (!Number.isSafeInteger(evidence.sequence) || evidence.sequence <= 0) {
    missing.push('sequence')
  }
  if (evidence.identityLink.linkedBy !== 'neutral_coordinator') {
    missing.push('identityLink.linkedBy')
  }
  if (evidence.identityLink.orcaIdentity === evidence.identityLink.externalIdentity) {
    missing.push('identityLink.distinctIdentities')
  }

  const ackValid =
    missing.length === 0 &&
    evidence.ackReadBack &&
    Boolean(evidence.ackMessageId) &&
    Number.isSafeInteger(evidence.ackSequence) &&
    (evidence.ackSequence ?? 0) > evidence.sequence &&
    evidence.ackCorrelationId === evidence.correlationId &&
    evidence.ackSenderEpoch === evidence.receiverEpoch &&
    evidence.ackReceiverEpoch === evidence.senderEpoch
  if (!ackValid) {
    missing.push('receiverAckQueryBack')
  }

  const completionValid =
    ackValid &&
    Boolean(evidence.completionReceiptId) &&
    evidence.nativeCompletionQueryBack &&
    evidence.nativeCompletionCorrelationId === evidence.correlationId
  if (!completionValid) {
    missing.push('nativeCompletionQueryBack')
  }

  const uniqueMissing = [...new Set(missing)]
  if (uniqueMissing.length === 0) {
    return {
      state: 'completion_verified',
      verified: true,
      effectsApplied: false,
      missing: []
    }
  }
  if (ackValid) {
    return {
      state: 'prompt_delivered',
      verified: false,
      effectsApplied: false,
      missing: uniqueMissing
    }
  }
  return {
    state: 'accepted',
    verified: false,
    effectsApplied: false,
    missing: uniqueMissing
  }
}
