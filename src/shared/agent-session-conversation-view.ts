import type {
  AgentSessionLease,
  AgentSessionRecord,
  AgentSessionClaimStatus,
  AgentSessionHandoffStage,
  AgentSessionProcessIdentity,
  AgentSessionDeathEvidence
} from './agent-session-record'

export type AgentSessionOwnerObservation = Readonly<{
  claimStatus: AgentSessionClaimStatus
  handoffStage: AgentSessionHandoffStage | null
  handoffOperationId: string | null
  ownerProcess: AgentSessionProcessIdentity | null
  reservedSpawnToken: string | null
  provenHandleLinkId: string | null
  leaseDeadlineAt: number
  lastRenewedAt: number
  deathEvidence: AgentSessionDeathEvidence | null
  unreconciled: boolean
}>

export type AgentSessionConversationView = Readonly<
  Omit<AgentSessionRecord, 'lease'> & {
    currentFence: number
    ownerObservation: AgentSessionOwnerObservation
    neverStarted: boolean
  }
>

type ConversationFacts = Omit<AgentSessionRecord, 'lease'> & {
  lease: Omit<AgentSessionLease, 'minimumNextFence'> & { minimumNextFence?: unknown }
}

export const AGENT_SESSION_FOUNDING_FENCE = 1

export function agentSessionNeverStarted({
  lease,
  providerHandleChain
}: ConversationFacts): boolean {
  return (
    lease.claimStatus === 'released' &&
    lease.runtimeFence === AGENT_SESSION_FOUNDING_FENCE &&
    lease.minimumNextFence === undefined &&
    lease.ownerProcess === null &&
    lease.reservedSpawnToken === null &&
    lease.handoffStage === null &&
    providerHandleChain.length === 0
  )
}

export function agentSessionConversationView(
  record: ConversationFacts
): AgentSessionConversationView {
  const { lease, ...conversation } = record
  const {
    claimStatus,
    handoffStage,
    handoffOperationId,
    ownerProcess,
    reservedSpawnToken,
    provenHandleLinkId,
    leaseDeadlineAt,
    lastRenewedAt,
    deathEvidence,
    unreconciled
  } = lease
  return {
    ...conversation,
    currentFence: lease.runtimeFence,
    neverStarted: agentSessionNeverStarted(record),
    ownerObservation: {
      claimStatus,
      handoffStage,
      handoffOperationId,
      ownerProcess,
      reservedSpawnToken,
      provenHandleLinkId,
      leaseDeadlineAt,
      lastRenewedAt,
      deathEvidence,
      unreconciled
    }
  }
}
