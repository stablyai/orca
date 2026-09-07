import { randomUUID } from 'node:crypto'
import {
  PTY_CONSUMER_OWNER_GRACE_MS,
  PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
  type PtyConsumerAuthentication,
  type PtyConsumerCloseCause,
  type PtyConsumerDisplacedOwner,
  type PtyConsumerSessionAdmission,
  type PtyConsumerSessionGrant,
  type PtyConsumerSessionHello,
  type PtyConsumerSessionOptions
} from './pty-consumer-session-contract'
import { assertNonEmptyString, validateHello } from './pty-consumer-session-hello'
import {
  assertPtyConsumerSessionOptions,
  intersectPtyConsumerCapabilities
} from './pty-consumer-session-capabilities'
import {
  assertPtyConsumerOwnerRecovery,
  isPtyConsumerOwnerSameClient,
  matchesPtyConsumerOwnerClaim
} from './pty-consumer-owner-recovery'
import { refuseHeldPtyConsumerOwner } from './pty-consumer-owner-admission'

export * from './pty-consumer-session-contract'

type ClientRecord = {
  principal: string
  clientInstanceId: string
  grant: Readonly<PtyConsumerSessionGrant>
  state: 'pending' | 'active' | 'displaced'
  publicationState: 'pending' | 'committed' | 'rolled-back'
}

type OwnerRecord = {
  connectionId: string
  principal: string
  clientInstanceId: string
  generation: number
  lease: string
  resumed: boolean
  state: 'pending' | 'active' | 'disconnected'
  disconnectedAt?: number
  disconnectCause?: PtyConsumerCloseCause
  replaces?: OwnerRecord
}

export class PtyConsumerSession {
  private readonly clients = new Map<string, ClientRecord>()
  private readonly now: () => number
  private readonly createLease: () => string
  private readonly ownerGraceMs: number
  private nextClientGeneration = 1
  private nextOwnerGeneration = 1
  private owner: OwnerRecord | null = null

  constructor(private readonly options: PtyConsumerSessionOptions) {
    assertPtyConsumerSessionOptions(options)
    this.now = options.now ?? Date.now
    this.createLease = options.createLease ?? randomUUID
    this.ownerGraceMs = options.ownerGraceMs ?? PTY_CONSUMER_OWNER_GRACE_MS
  }

  admit(
    hello: PtyConsumerSessionHello,
    authentication: PtyConsumerAuthentication
  ): PtyConsumerSessionAdmission {
    validateHello(hello)
    assertNonEmptyString(authentication.connectionId, 'connectionId')
    assertNonEmptyString(authentication.principal, 'principal')
    if (!authentication.authenticated) {
      throw new Error('PTY consumer authentication required')
    }
    this.expireOwner()

    // Why even an identical repeat is rejected: the two responses settle their publications
    // independently, so one shared admission cannot make one response's rollback and the other's
    // commit atomic. A client recovering from an RPC timeout opens a new connection instead.
    if (this.clients.has(authentication.connectionId)) {
      throw new Error('pty.openClient may be used only once per transport connection')
    }

    const owner = this.selectOwner(hello, authentication)
    const grant = Object.freeze({
      protocolVersion: PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
      serverBuildId: this.options.serverBuildId,
      clientGeneration: this.nextClientGeneration++,
      role: owner ? ('session-owner' as const) : ('subscriber' as const),
      ...(owner
        ? { ownerGeneration: owner.generation, ownerLease: owner.lease, resumed: owner.resumed }
        : {}),
      ...intersectPtyConsumerCapabilities(hello, this.options.outputFlowControl)
    })
    const client: ClientRecord = {
      principal: authentication.principal,
      clientInstanceId: hello.clientInstanceId,
      grant,
      state: 'pending',
      publicationState: 'pending'
    }
    this.clients.set(authentication.connectionId, client)
    if (owner) {
      this.owner = owner
    }
    return this.admissionFor(client, this.displacedOwnerFor(owner))
  }

  // Why the cause defaults to 'local': it only ever widens the grace this record keeps, so a caller
  // that cannot prove the peer's transport ended gets the answer that costs a live owner nothing.
  close(connectionId: string, cause: PtyConsumerCloseCause = 'local'): void {
    const client = this.clients.get(connectionId)
    if (!client) {
      return
    }
    this.clients.delete(connectionId)
    if (this.owner?.connectionId !== connectionId) {
      // Why: a pending replacement can still roll back onto the owner it is displacing; restoring an
      // 'active' record whose connection has since closed would wedge an owner that can never expire.
      if (
        this.owner?.replaces?.connectionId === connectionId &&
        this.owner.replaces.state === 'active'
      ) {
        this.owner = {
          ...this.owner,
          replaces: {
            ...this.owner.replaces,
            state: 'disconnected',
            disconnectedAt: this.now(),
            disconnectCause: cause
          }
        }
      }
      return
    }
    if (this.owner.state === 'pending') {
      this.owner = this.owner.replaces ?? null
      return
    }
    this.owner = {
      ...this.owner,
      state: 'disconnected',
      disconnectedAt: this.now(),
      disconnectCause: cause
    }
  }

  sweepExpired(): void {
    this.expireOwner()
  }

  activeGrant(connectionId: string): Readonly<PtyConsumerSessionGrant> | null {
    const client = this.clients.get(connectionId)
    return client?.state === 'active' ? client.grant : null
  }

  /** The authenticated client identity behind an active connection, or null.
   *
   *  Why the host reads it here instead of taking a spawn parameter: this is what makes a later
   *  "this PTY belongs to you" attestation evidence rather than an echo of what a caller claimed. */
  activeClientInstanceId(connectionId: string): string | null {
    const client = this.clients.get(connectionId)
    return client?.state === 'active' ? client.clientInstanceId : null
  }

  private admissionFor(
    client: ClientRecord,
    displacedOwner?: Readonly<PtyConsumerDisplacedOwner>
  ): PtyConsumerSessionAdmission {
    return {
      grant: client.grant,
      ...(displacedOwner ? { displacedOwner } : {}),
      commitPublication: () => {
        if (client.publicationState !== 'pending') {
          return
        }
        client.publicationState = 'committed'
        if (client.state !== 'pending') {
          return
        }
        client.state = 'active'
        const owner = this.owner
        if (owner?.connectionId === this.connectionIdFor(client) && owner.state === 'pending') {
          this.retireDisplacedOwner(owner.replaces)
          this.owner = { ...owner, state: 'active', replaces: undefined }
        }
      },
      rollbackPublication: () => {
        if (client.publicationState !== 'pending') {
          return
        }
        client.publicationState = 'rolled-back'
        if (client.state !== 'pending') {
          return
        }
        const connectionId = this.connectionIdFor(client)
        this.clients.delete(connectionId)
        if (this.owner?.connectionId === connectionId && this.owner.state === 'pending') {
          this.owner = this.owner.replaces ?? null
        }
      }
    }
  }

  private connectionIdFor(client: ClientRecord): string {
    for (const [connectionId, candidate] of this.clients) {
      if (candidate === client) {
        return connectionId
      }
    }
    return ''
  }

  private selectOwner(
    hello: PtyConsumerSessionHello,
    authentication: PtyConsumerAuthentication
  ): OwnerRecord | null {
    if (hello.requestedRole !== 'session-owner' || !authentication.allowSessionOwner) {
      return null
    }
    const current = this.owner
    // Why resume proof for a vacant record is not an error: the relay simply no longer has the record
    // the client is naming. Minting a fresh claim here resolves it in one round trip, and `resumed:
    // false` tells the client its checkpoints are void without making it delete its identity first.
    if (!current) {
      return this.newOwner(hello, authentication, null)
    }
    if (!matchesPtyConsumerOwnerClaim(hello, authentication, current)) {
      refuseHeldPtyConsumerOwner(current, {
        ownerGraceMs: this.ownerGraceMs,
        now: this.now(),
        sameClient: isPtyConsumerOwnerSameClient(hello, authentication, current),
        clampGraceTo: (disconnectedAt) => {
          this.owner = { ...current, disconnectedAt }
        }
      })
    }
    assertPtyConsumerOwnerRecovery(hello, authentication, current)
    // Why an active owner is displaced rather than refused: the resume proof matched this owner's
    // generation, lease, client instance, and principal on a *different* transport, so the requester is
    // the same logical owner reconnecting. Waiting for the incumbent's socket to close is unbounded —
    // a half-open connection after sleep/resume or NAT loss never gets there.
    return this.newOwner(hello, authentication, current)
  }

  private displacedOwnerFor(
    owner: OwnerRecord | null
  ): Readonly<PtyConsumerDisplacedOwner> | undefined {
    const replaced = owner?.replaces
    if (replaced?.state !== 'active') {
      return undefined
    }
    const client = this.clients.get(replaced.connectionId)
    if (client?.state !== 'active') {
      return undefined
    }
    return Object.freeze({ connectionId: replaced.connectionId, grant: client.grant })
  }

  // Why: the displaced connection may still be writable (half-open), so revoke its grant the moment the
  // replacement is published — a stale owner must not keep driving deliveries under the old generation.
  private retireDisplacedOwner(replaced: OwnerRecord | undefined): void {
    if (replaced?.state !== 'active') {
      return
    }
    const client = this.clients.get(replaced.connectionId)
    if (client?.state === 'active') {
      client.state = 'displaced'
    }
  }

  private newOwner(
    hello: PtyConsumerSessionHello,
    authentication: PtyConsumerAuthentication,
    replaces: OwnerRecord | null
  ): OwnerRecord {
    const lease = replaces?.lease ?? this.createLease()
    assertNonEmptyString(lease, 'ownerLease')
    return {
      connectionId: authentication.connectionId,
      principal: authentication.principal,
      clientInstanceId: hello.clientInstanceId,
      generation: this.nextOwnerGeneration++,
      lease,
      resumed: replaces !== null,
      state: 'pending',
      ...(replaces ? { replaces } : {})
    }
  }

  private expireOwner(): void {
    if (
      this.owner?.state === 'disconnected' &&
      this.now() - (this.owner.disconnectedAt ?? this.now()) >= this.ownerGraceMs
    ) {
      this.owner = null
    }
  }
}
