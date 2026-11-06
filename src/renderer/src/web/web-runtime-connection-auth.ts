import {
  createPairedE2EEClientHandshake,
  type PairedE2EEAuthReply,
  type PairedE2EEClientHandshake
} from '../../../shared/remote-runtime/e2ee/paired-e2ee-client-handshake'
import type { PairedE2EEFramingPolicy } from '../../../shared/remote-runtime/e2ee/paired-e2ee-framing-policy'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { resolveWebRuntimeAuthRejection } from './web-runtime-auth-verdict'
import {
  createWebRuntimeUnauthorizedError,
  type WebRuntimeAuthFailureReason,
  type WebRuntimeClientError
} from './web-runtime-client-error'
import {
  sealWebRuntimePlanAuth,
  type WebRuntimeConnectionState
} from './web-runtime-connection-frame-router'
import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { WEB_PAIRED_E2EE_PRIMITIVES } from './web-paired-e2ee-primitives'
import {
  tokenOnlyCredentialSource,
  withWebRuntimeAuthPlan,
  withoutTokenOnKeyedSocket,
  type WebRuntimeAuthPlan,
  type WebRuntimeCredentialSource
} from './web-runtime-credential-source'
import { migrateWebRuntimeToDeviceKey } from './web-runtime-device-key-migration'
import { isWebHostLatchedToE2EEV2, webE2EEFramingPolicy } from './web-e2ee-v2-host-latch'

const UNSUPPORTED_HELLO_CLOSE_CODE = 4001

export type WebRuntimeConnectionLifecycle = {
  onStateChanged?: (state: WebRuntimeConnectionState) => void
  reconnect?: boolean
  credential?: WebRuntimeCredentialSource
  // Why: only the primary socket registers a key; helper sockets reuse it once active.
  allowKeyMigration?: boolean
  crewAttempt?: true
  assertCurrent?: () => void
}

/** How one web transport authenticates each socket it opens (token, key, or a key migration). */
export class WebRuntimeConnectionAuth {
  plan: WebRuntimeAuthPlan | null = null
  private readyAccepted = false
  // This socket sends the token over v2; an older host may refuse it, then the token goes legacy.
  private tokenOverV2 = false
  private failureReason: WebRuntimeAuthFailureReason = 'unauthorized'

  private readonly credential: WebRuntimeCredentialSource
  private readonly allowKeyMigration: boolean
  private readonly retryLater: () => void
  private readonly hostPublicKeyB64: string
  private readonly framingPolicy: PairedE2EEFramingPolicy
  // Only a reconnecting socket can absorb an older host refusing a v2 attempt.
  private readonly mayTryV2Token: boolean

  constructor(
    connection: PairedRuntimeConnection,
    options: WebRuntimeConnectionLifecycle & {
      // No plan could be built (a migrated pairing whose key store is broken).
      retryLater: () => void
    }
  ) {
    // Why: an invalid host key fails construction, not the first connect.
    WEB_PAIRED_E2EE_PRIMITIVES.publicKeyFromBase64(connection.hostPublicKeyB64)
    const deviceToken = connection.credential.deviceToken
    this.retryLater = options.retryLater
    // Absent: the pairing token over legacy framing, as before device keys.
    this.credential = options.credential ?? tokenOnlyCredentialSource(deviceToken)
    this.allowKeyMigration = options.allowKeyMigration === true
    this.hostPublicKeyB64 = connection.hostPublicKeyB64
    this.framingPolicy = webE2EEFramingPolicy(connection.hostPublicKeyB64)
    this.mayTryV2Token =
      this.credential.tryV2Token === true &&
      options.reconnect !== false &&
      options.crewAttempt !== true
  }

  /** Resolves the next plan, then opens; synchronous for a token-only source. */
  open(openSocket: (plan: WebRuntimeAuthPlan) => void): void {
    withWebRuntimeAuthPlan(
      this.credential,
      this.allowKeyMigration,
      (plan) => {
        this.plan = plan
        this.readyAccepted = false
        openSocket(plan)
      },
      this.retryLater
    )
  }

  /** Keys and migrations are v2; the token is v2 for hosts known to take it, else tried when a refusal can be absorbed. */
  createHandshake(plan: WebRuntimeAuthPlan): PairedE2EEClientHandshake {
    this.tokenOverV2 =
      plan.kind === 'legacy-token' &&
      (isWebHostLatchedToE2EEV2(this.hostPublicKeyB64) ||
        (this.mayTryV2Token && this.framingPolicy.framingForNextDial() === 'v2'))
    const handshake = createPairedE2EEClientHandshake({
      primitives: WEB_PAIRED_E2EE_PRIMITIVES,
      hostPublicKeyB64: this.hostPublicKeyB64,
      framing: plan.kind !== 'legacy-token' || this.tokenOverV2 ? 'v2' : 'legacy',
      transport: 'direct',
      legacyGate: this.framingPolicy,
      // Why token sockets only: a migration's token auth stays the shape older key hosts accept.
      v2TokenCapabilities: this.tokenOverV2
    })
    if (!this.tokenOverV2) {
      return handshake
    }
    return {
      ...handshake,
      classifyAuthReply: (plaintext) => {
        const reply = handshake.classifyAuthReply(plaintext)
        if (reply.kind === 'authenticated') {
          this.framingPolicy.noteV2Authenticated()
        }
        return reply
      }
    }
  }

  async sendAuth(args: {
    handshake: PairedE2EEClientHandshake
    fallbackToken: string
    isCurrent: () => boolean
    send: (frame: string) => void
    fail: (error: unknown) => void
  }): Promise<void> {
    this.readyAccepted = true
    let frame: string
    try {
      frame = await sealWebRuntimePlanAuth(args.handshake, this.plan, args.fallbackToken)
    } catch (error) {
      args.fail(error)
      return
    }
    if (args.isCurrent()) {
      args.send(frame)
    }
  }

  outbound(message: unknown): unknown {
    return withoutTokenOnKeyedSocket(this.plan, message)
  }

  failureError(): WebRuntimeClientError {
    return createWebRuntimeUnauthorizedError(this.failureReason)
  }

  /** True when this socket is a key migration, which then reconnects instead of going live. */
  migrateIfPlanned(args: {
    handshake: PairedE2EEClientHandshake
    beginMigration: () => void
    call: (method: string, params?: unknown) => Promise<RuntimeRpcResponse<unknown>>
    reconnect: () => void
  }): boolean {
    const plan = this.plan
    if (plan?.kind !== 'migrate') {
      return false
    }
    args.beginMigration()
    void migrateWebRuntimeToDeviceKey({
      plan,
      transcriptHashB64: args.handshake.transcriptHashB64(),
      source: this.credential,
      call: args.call
    }).then(args.reconnect)
    return true
  }

  async rejected(
    reply: Extract<PairedE2EEAuthReply, { kind: 'rejected' }>
  ): Promise<{ kind: 'retry' } | { kind: 'failed'; error: WebRuntimeClientError }> {
    // Hosts that predate capabilities on v2 token auth answer bad_auth; reconnect with legacy.
    if (reply.errorCode === 'bad_auth' && this.tokenOverV2 && this.noteOlderHostRefusedV2()) {
      return { kind: 'retry' }
    }
    const outcome = await resolveWebRuntimeAuthRejection(this.plan, reply, this.credential)
    if (outcome.kind === 'retry') {
      return outcome
    }
    this.failureReason = outcome.reason
    return { kind: 'failed', error: this.failureError() }
  }

  socketClosed(closeCode?: number): void {
    // Why: a host that refuses a v2 hello predates device keys; fall back to the token.
    if (this.plan?.kind === 'migrate' && !this.readyAccepted) {
      this.credential.migrationUnavailable()
    }
    const v2Hello = this.tokenOverV2 || this.plan?.kind === 'migrate'
    if (v2Hello && !this.readyAccepted && closeCode === UNSUPPORTED_HELLO_CLOSE_CODE) {
      this.noteOlderHostRefusedV2()
    }
  }

  private noteOlderHostRefusedV2(): boolean {
    // Why: a host that took v2 token auth before is never downgraded; its refusal is a failure.
    if (this.framingPolicy.helloRefusalIsAuthFailure()) {
      return false
    }
    this.tokenOverV2 = false
    this.framingPolicy.noteV2HelloRefused()
    return true
  }
}

export async function handleRejectedWebRuntimeAuth(
  reply: Parameters<WebRuntimeConnectionAuth['rejected']>[0],
  {
    auth,
    lifecycle,
    getSocket,
    isClosed,
    failSetup,
    failAuth,
    close
  }: {
    auth: WebRuntimeConnectionAuth
    lifecycle: WebRuntimeConnectionLifecycle
    getSocket: () => WebSocket | null
    isClosed: () => boolean
    failSetup: (error: unknown) => void
    failAuth: (error: WebRuntimeClientError) => void
    close: () => void
  }
): Promise<void> {
  const socket = getSocket()
  let outcome: Awaited<ReturnType<WebRuntimeConnectionAuth['rejected']>>
  try {
    lifecycle.assertCurrent?.()
    outcome = await auth.rejected(reply)
    if (lifecycle.crewAttempt && getSocket() === socket && !isClosed()) {
      lifecycle.assertCurrent?.()
    }
  } catch (error) {
    if (!lifecycle.crewAttempt) {
      throw error
    }
    if (getSocket() === socket && !isClosed()) {
      failSetup(error)
    }
    return
  }
  if (lifecycle.crewAttempt && (getSocket() !== socket || isClosed())) {
    return
  }
  if (outcome.kind === 'failed') {
    failAuth(outcome.error)
  }
  if (lifecycle.crewAttempt) {
    close()
  } else {
    socket?.close()
  }
}
