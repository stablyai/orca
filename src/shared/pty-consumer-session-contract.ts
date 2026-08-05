export const PTY_CONSUMER_SESSION_PROTOCOL_VERSION = 1
export const PTY_CONSUMER_OWNER_GRACE_MS = 30_000
export const PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR = -32041
// Why: recovery is blocked only while the incumbent owner's grant publication is still settling — a
// window bounded by one response write, so the client may retry within a short budget.
export const PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR = -32042
export const PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR = -32043

export type PtyConsumerRole = 'session-owner' | 'subscriber'

export type PtyConsumerSessionHello = {
  clientInstanceId: string
  requestedRole: PtyConsumerRole
  resume?: {
    ownerGeneration: number
    ownerLease: string
  }
  capabilities?: {
    outputFlowControl?: {
      versions: number[]
      requestedWindowSu: number
    }
  }
}

export type PtyConsumerSessionGrant = {
  protocolVersion: typeof PTY_CONSUMER_SESSION_PROTOCOL_VERSION
  serverBuildId: string
  clientGeneration: number
  role: PtyConsumerRole
  ownerGeneration?: number
  ownerLease?: string
  capabilities?: {
    outputFlowControl?: {
      version: 1
      windowSu: number
    }
  }
}

export type PtyConsumerAuthentication = {
  connectionId: string
  principal: string
  authenticated: boolean
  allowSessionOwner: boolean
}

export type PtyConsumerDisplacedOwner = {
  connectionId: string
  grant: Readonly<PtyConsumerSessionGrant>
}

export type PtyConsumerSessionAdmission = {
  grant: Readonly<PtyConsumerSessionGrant>
  // Why: set when this admission takes over a still-attached owner. The transport layer owns closing
  // that connection and releasing its deliveries — do it only once the new grant has been published.
  displacedOwner?: Readonly<PtyConsumerDisplacedOwner>
  commitPublication: () => void
  rollbackPublication: () => void
}

export type PtyConsumerSessionOptions = {
  serverBuildId: string
  outputFlowControl?: {
    versions: readonly number[]
    maxWindowSu: number
  }
  ownerGraceMs?: number
  now?: () => number
  createLease?: () => string
}
