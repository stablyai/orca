import { randomUUID } from 'node:crypto'
import {
  PTY_CONSUMER_OWNER_GRACE_MS,
  PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
  PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR,
  type PtyConsumerAuthentication,
  type PtyConsumerDisplacedOwner,
  type PtyConsumerSessionAdmission,
  type PtyConsumerSessionGrant,
  type PtyConsumerSessionHello,
  type PtyConsumerSessionOptions
} from './pty-consumer-session-contract'
import {
  assertNonEmptyString,
  helloFingerprint,
  MAX_CAPABILITY_VERSIONS,
  validateHello
} from './pty-consumer-session-hello'
import { assertPtyConsumerOwnerRecovery } from './pty-consumer-owner-recovery'

export * from './pty-consumer-session-contract'

type ClientRecord = {
  fingerprint: string
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
  state: 'pending' | 'active' | 'disconnected'
  disconnectedAt?: number
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
    assertNonEmptyString(options.serverBuildId, 'serverBuildId')
    if (
      options.outputFlowControl &&
      (!Number.isSafeInteger(options.outputFlowControl.maxWindowSu) ||
        options.outputFlowControl.maxWindowSu <= 0 ||
        options.outputFlowControl.versions.length > MAX_CAPABILITY_VERSIONS ||
        options.outputFlowControl.versions.some(
          (version) => !Number.isSafeInteger(version) || version <= 0
        ))
    ) {
      throw new Error('outputFlowControl support is invalid')
    }
    if (
      options.ownerGraceMs !== undefined &&
      (!Number.isSafeInteger(options.ownerGraceMs) || options.ownerGraceMs < 0)
    ) {
      throw new Error('ownerGraceMs must be a non-negative safe integer')
    }
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

    const fingerprint = helloFingerprint(hello)
    const duplicate = this.clients.get(authentication.connectionId)
    if (duplicate) {
      if (
        duplicate.fingerprint !== fingerprint ||
        duplicate.principal !== authentication.principal
      ) {
        throw new Error('pty.openClient may be used only once per transport connection')
      }
      return this.admissionFor(duplicate)
    }

    const owner = this.selectOwner(hello, authentication)
    const grant = Object.freeze({
      protocolVersion: PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
      serverBuildId: this.options.serverBuildId,
      clientGeneration: this.nextClientGeneration++,
      role: owner ? ('session-owner' as const) : ('subscriber' as const),
      ...(owner ? { ownerGeneration: owner.generation, ownerLease: owner.lease } : {}),
      ...this.intersectCapabilities(hello)
    })
    const client: ClientRecord = {
      fingerprint,
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

  close(connectionId: string): void {
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
          replaces: { ...this.owner.replaces, state: 'disconnected', disconnectedAt: this.now() }
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
      disconnectedAt: this.now()
    }
  }

  sweepExpired(): void {
    this.expireOwner()
  }

  activeGrant(connectionId: string): Readonly<PtyConsumerSessionGrant> | null {
    const client = this.clients.get(connectionId)
    return client?.state === 'active' ? client.grant : null
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
    if (!current) {
      if (hello.resume) {
        throw Object.assign(new Error('Owner recovery lease is stale'), {
          code: PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR
        })
      }
      return this.newOwner(hello, authentication, null)
    }
    if (!hello.resume) {
      return null
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
      state: 'pending',
      ...(replaces ? { replaces } : {})
    }
  }

  private intersectCapabilities(
    hello: PtyConsumerSessionHello
  ): Pick<PtyConsumerSessionGrant, 'capabilities'> {
    const offer = hello.capabilities?.outputFlowControl
    const support = this.options.outputFlowControl
    if (!offer || !support || !offer.versions.includes(1) || !support.versions.includes(1)) {
      return {}
    }
    return {
      capabilities: {
        outputFlowControl: {
          version: 1,
          windowSu: Math.min(offer.requestedWindowSu, support.maxWindowSu)
        }
      }
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
