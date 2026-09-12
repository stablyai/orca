import {
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR,
  PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR,
  type PtyConsumerAuthentication,
  type PtyConsumerSessionHello
} from './pty-consumer-session-contract'

type IncumbentOwner = {
  principal: string
  clientInstanceId: string
  generation: number
  lease: string
  state: 'pending' | 'active' | 'disconnected'
  replaces?: { generation: number }
}

function throwRecoveryError(message: string, code: number): never {
  throw Object.assign(new Error(message), { code })
}

// Why identity excludes ownerGeneration: the generation fences the data path, but a reconnecting
// owner legitimately arrives holding whatever generation it last persisted. Matching on the logical
// triple is what lets one claim survive reconnects.
export function matchesPtyConsumerOwnerClaim(
  hello: PtyConsumerSessionHello,
  authentication: PtyConsumerAuthentication,
  current: IncumbentOwner
): boolean {
  const resume = hello.resume
  return (
    resume !== undefined &&
    resume.ownerLease === current.lease &&
    hello.clientInstanceId === current.clientInstanceId &&
    authentication.principal === current.principal
  )
}

// Why identity without the lease, next to the claim match above: a client that lost its recovery
// record still knows its own instance id, and against an incumbent carrying that id the incumbent is
// its own earlier connection. Enough to call a refusal transient; never enough to hand over a claim.
export function isPtyConsumerOwnerSameClient(
  hello: PtyConsumerSessionHello,
  authentication: PtyConsumerAuthentication,
  current: IncumbentOwner
): boolean {
  return (
    hello.clientInstanceId === current.clientInstanceId &&
    authentication.principal === current.principal
  )
}

export function assertPtyConsumerOwnerRecovery(
  hello: PtyConsumerSessionHello,
  authentication: PtyConsumerAuthentication,
  current: IncumbentOwner
): void {
  const resume = hello.resume
  if (!resume) {
    throw new Error('Owner recovery proof is required')
  }
  if (!matchesPtyConsumerOwnerClaim(hello, authentication, current)) {
    throwRecoveryError(
      'Owner recovery lease is stale or belongs to another principal',
      PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR
    )
  }
  if (current.state === 'active' && resume.ownerGeneration < current.generation) {
    throwRecoveryError(
      'Owner recovery generation was superseded',
      PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR
    )
  }
  const generationMatches =
    resume.ownerGeneration === current.generation ||
    (current.state === 'pending' && resume.ownerGeneration === current.replaces?.generation) ||
    (current.state === 'disconnected' && resume.ownerGeneration < current.generation)
  if (!generationMatches) {
    throwRecoveryError(
      'Owner recovery generation is stale',
      PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR
    )
  }
  if (current.state === 'pending') {
    throwRecoveryError(
      'Owner grant publication is still pending',
      PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR
    )
  }
}
