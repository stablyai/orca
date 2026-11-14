import type { AgentSessionLease, AgentSessionRecord } from './agent-session-record'

export type AgentSessionConversationView = Readonly<ReturnType<typeof agentSessionConversationView>>
export type AgentSessionOwnerObservation = AgentSessionConversationView['ownerObservation']

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

export function agentSessionConversationView(record: ConversationFacts) {
  const { lease, acquiredAccount: _acquiredAccount, ...conversation } = record
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
  } as const
}
