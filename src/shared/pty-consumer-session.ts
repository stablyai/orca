import { randomUUID } from 'node:crypto'
import {
  PTY_CONSUMER_OWNER_GRACE_MS,
  PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
  PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR,
  type PtyConsumerAuthentication,
  type PtyConsumerSessionAdmission,
  type PtyConsumerSessionGrant,
  type PtyConsumerSessionHello,
  type PtyConsumerSessionOptions
} from './pty-consumer-session-contract'

export * from './pty-consumer-session-contract'

const MAX_CAPABILITY_VERSIONS = 8

type ClientRecord = {
  fingerprint: string
  principal: string
  clientInstanceId: string
  grant: Readonly<PtyConsumerSessionGrant>
  state: 'pending' | 'active'
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

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error(`${name} must be a non-empty string of at most 512 characters`)
  }
}

function validateHello(hello: PtyConsumerSessionHello): void {
  assertNonEmptyString(hello.clientInstanceId, 'clientInstanceId')
  if (hello.requestedRole !== 'session-owner' && hello.requestedRole !== 'subscriber') {
    throw new Error('requestedRole must be session-owner or subscriber')
  }
  if (hello.resume) {
    if (!Number.isSafeInteger(hello.resume.ownerGeneration) || hello.resume.ownerGeneration <= 0) {
      throw new Error('resume.ownerGeneration must be a positive safe integer')
    }
    assertNonEmptyString(hello.resume.ownerLease, 'resume.ownerLease')
  }
  const flow = hello.capabilities?.outputFlowControl
  if (!flow) {
    return
  }
  if (
    !Array.isArray(flow.versions) ||
    flow.versions.length > MAX_CAPABILITY_VERSIONS ||
    flow.versions.some((version) => !Number.isSafeInteger(version) || version <= 0)
  ) {
    throw new Error('outputFlowControl.versions must contain positive safe integers')
  }
  if (!Number.isSafeInteger(flow.requestedWindowSu) || flow.requestedWindowSu <= 0) {
    throw new Error('outputFlowControl.requestedWindowSu must be a positive safe integer')
  }
}

function helloFingerprint(hello: PtyConsumerSessionHello): string {
  const flow = hello.capabilities?.outputFlowControl
  return JSON.stringify({
    clientInstanceId: hello.clientInstanceId,
    requestedRole: hello.requestedRole,
    resume: hello.resume,
    outputFlowControl: flow
      ? {
          versions: [...flow.versions].sort((a, b) => a - b),
          requestedWindowSu: flow.requestedWindowSu
        }
      : undefined
  })
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
    return this.admissionFor(client)
  }

  close(connectionId: string): void {
    const client = this.clients.get(connectionId)
    if (!client) {
      return
    }
    this.clients.delete(connectionId)
    if (this.owner?.connectionId !== connectionId) {
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

  private admissionFor(client: ClientRecord): PtyConsumerSessionAdmission {
    return {
      grant: client.grant,
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
    const recoveryMatches =
      hello.resume.ownerGeneration === current.generation &&
      hello.resume.ownerLease === current.lease &&
      hello.clientInstanceId === current.clientInstanceId &&
      authentication.principal === current.principal
    if (!recoveryMatches) {
      throw Object.assign(
        new Error('Owner recovery lease is stale or belongs to another principal'),
        { code: PTY_CONSUMER_STALE_OWNER_RECOVERY_ERROR }
      )
    }
    if (current.state === 'pending') {
      throw new Error('Owner grant publication is still pending')
    }
    if (current.state !== 'disconnected') {
      throw new Error('Active owner cannot be replaced by recovery')
    }
    return this.newOwner(hello, authentication, current)
  }

  private newOwner(
    hello: PtyConsumerSessionHello,
    authentication: PtyConsumerAuthentication,
    replaces: OwnerRecord | null
  ): OwnerRecord {
    const lease = this.createLease()
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
