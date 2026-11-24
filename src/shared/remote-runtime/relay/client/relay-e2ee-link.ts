import { WsInboundMessageQueue } from '../../../network/websocket/ws-inbound-message-queue'
import { createPairedE2EEClientHandshake } from '../../e2ee/paired-e2ee-client-handshake'
import { RelayPhoneHelloSchema, type RelayPhoneHello } from '../mobile-relay-phone-protocol'
import { relayHostCloseReasonFrom, type RelayHostCloseReason } from '../relay-host-close-reason'
import {
  PairedE2EEV2PhysicalChannel,
  type PairedE2EEClientCredential
} from './paired-e2ee-v2-physical-channel'
import type { RelayClientPlatform, RelayClientSocket } from './relay-client-platform'
import { relayConnectWebSocketUrl } from './relay-connect-url'

// Sockets normally emit close immediately after error or a relay-hello
// refusal; bound the missing-close case so recovery is never left pending.
const RELAY_ERROR_CLOSE_GRACE_MS = 250

export class RelayOuterError extends Error {
  // Distinguish hello refusal from close codes; compare free-text close reasons only by exact value.
  constructor(
    readonly code: number,
    readonly rejectedByRelayHello = false,
    readonly closeReason = ''
  ) {
    super(`relay_outer_${code}`)
  }
}

export type RelayE2eeLinkOptions = {
  platform: RelayClientPlatform
  endpoint: { cellUrl: string; relayHostId: string }
  // The relay's invite or resume bearer, presented to the cell before E2EE starts.
  credential: string
  expectedCredentialKind: 'invite' | 'resume'
  // What authenticates this device to the host inside E2EE: a phone's token or a device key.
  authCredential: PairedE2EEClientCredential
  desktopPublicKeyB64: string
  onAuthenticated: () => void
  onText: (plaintext: string) => void
  onBinary: (plaintext: Uint8Array) => void
  onHello?: (hello: Extract<RelayPhoneHello, { ok: true }>) => void
  // Report close reasons separately because hello refusal and close dispatch order is unspecified, and only close names the cause.
  onHostCloseReason?: (reason: RelayHostCloseReason) => void
  // Fired once relay-auth is on the wire: from here the cell owns the wait.
  onOpen?: () => void
  onError: (error: Error) => void
}

/** A relay client's socket to a host: relay-auth and hello with the cell, then E2EE v2 with the host. */
export class RelayE2eeLink {
  private readonly options: RelayE2eeLinkOptions
  private readonly socket: RelayClientSocket
  private readonly channel: PairedE2EEV2PhysicalChannel
  private outerReady = false
  private constructed = false
  private closed = false
  private rejectedHelloCode: number | null = null
  private closeGraceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly inbound: WsInboundMessageQueue

  constructor(options: RelayE2eeLinkOptions) {
    this.options = options
    const { platform } = options
    // Why first: a malformed stored host key throws here, before any socket exists.
    const handshake = createPairedE2EEClientHandshake({
      primitives: platform.primitives,
      hostPublicKeyB64: options.desktopPublicKeyB64,
      framing: 'v2',
      transport: 'relay',
      relayHostId: options.endpoint.relayHostId
    })
    this.inbound = new WsInboundMessageQueue(
      async (raw) => {
        if (this.closed || this.rejectedHelloCode !== null) {
          return
        }
        if (!this.outerReady) {
          this.acceptHello(raw)
        } else {
          await this.channel.handleMessage(raw)
        }
      },
      (error) => this.fail(asError(error))
    )
    // A platform that breaks the contract and fires during createSocket is replayed once it returns.
    const wired = (handle: () => void): void => {
      if (this.constructed) {
        handle()
      } else {
        queueMicrotask(handle)
      }
    }
    this.socket = platform.createSocket(
      relayConnectWebSocketUrl(options.endpoint.cellUrl, options.endpoint.relayHostId),
      {
        onOpen: () => wired(() => this.sendRelayAuth()),
        onMessage: (data) => wired(() => void this.inbound.enqueue(data)),
        // `error` is often delivered just before `close`; wait for close so a
        // typed relay code is not replaced by a generic transport error.
        onError: () =>
          wired(() => {
            if (!this.closed) {
              this.awaitClose()
            }
          }),
        onClose: (code, reason) => wired(() => this.handleClose(code, reason))
      }
    )
    this.channel = new PairedE2EEV2PhysicalChannel({
      handshake,
      socket: this.socket,
      credential: options.authCredential,
      decodeBinary: platform.decodeBinary,
      inflateFrame: platform.inflateFrame,
      onAuthenticated: () => {
        platform.latchHostToE2EEV2?.(options.desktopPublicKeyB64)
        options.onAuthenticated()
      },
      onText: options.onText,
      onBinary: options.onBinary,
      onError: (error) => this.fail(error)
    })
    this.constructed = true
  }

  sendText(plaintext: string): boolean {
    return !this.closed && this.channel.sendText(plaintext)
  }

  sendBinary(plaintext: Uint8Array): boolean {
    return !this.closed && this.channel.sendBinary(plaintext)
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.clearCloseGrace()
    this.inbound.dispose()
    this.channel.dispose()
    this.socket.close()
  }

  private sendRelayAuth(): void {
    try {
      this.socket.send(
        JSON.stringify({
          type: 'relay-auth',
          v: 1,
          mode: 'connect',
          credential: this.options.credential
        })
      )
    } catch (error) {
      this.fail(asError(error))
      return
    }
    this.options.onOpen?.()
  }

  private handleClose(code: number, reason: string): void {
    this.clearCloseGrace()
    // Ahead of fail(), which no-ops once a missing close already timed out.
    const hostCloseReason = relayHostCloseReasonFrom(reason)
    if (hostCloseReason) {
      this.options.onHostCloseReason?.(hostCloseReason)
    }
    this.fail(
      new RelayOuterError(
        this.rejectedHelloCode ?? (code || 1006),
        this.rejectedHelloCode !== null,
        reason
      )
    )
  }

  // Bound waiting for close reason; dead sockets may never emit it.
  private awaitClose(): void {
    this.closeGraceTimer ??= setTimeout(() => {
      this.closeGraceTimer = null
      this.fail(
        new RelayOuterError(this.rejectedHelloCode ?? 1006, this.rejectedHelloCode !== null)
      )
    }, RELAY_ERROR_CLOSE_GRACE_MS)
  }

  private clearCloseGrace(): void {
    if (this.closeGraceTimer) {
      clearTimeout(this.closeGraceTimer)
      this.closeGraceTimer = null
    }
  }

  private acceptHello(raw: unknown): void {
    if (typeof raw !== 'string') {
      throw new Error('expected plaintext relay hello')
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('invalid relay hello JSON')
    }
    const parsed = RelayPhoneHelloSchema.safeParse(value)
    if (!parsed.success) {
      throw new Error('invalid relay hello')
    }
    if (!parsed.data.ok) {
      // Wait for the following close to preserve the reason needed by recovery.
      this.rejectedHelloCode = parsed.data.code
      this.awaitClose()
      return
    }
    if (parsed.data.credentialKind !== this.options.expectedCredentialKind) {
      throw new Error('relay credential resolved as an unexpected credential kind')
    }
    this.outerReady = true
    this.options.onHello?.(parsed.data)
    // onHello may refuse this hello by closing the link.
    if (!this.closed) {
      this.channel.start()
    }
  }

  private fail(error: Error): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.clearCloseGrace()
    this.inbound.dispose()
    this.channel.dispose()
    this.options.onError(error)
    this.socket.close()
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

// A token client stamps its token on every request; a device-key socket is itself the principal.
export function relayRequestCredentialFields(credential: PairedE2EEClientCredential): {
  deviceToken?: string
} {
  return credential.kind === 'token' ? { deviceToken: credential.deviceToken } : {}
}
