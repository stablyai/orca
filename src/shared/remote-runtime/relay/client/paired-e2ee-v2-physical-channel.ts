import {
  createWsOutboundBackpressureQueue,
  type WsOutboundBackpressureQueue
} from '../../../network/websocket/ws-outbound-backpressure-queue'
import { WsInboundMessageQueue } from '../../../network/websocket/ws-inbound-message-queue'
import type {
  PairedE2EEAuthCredential,
  PairedE2EEClientHandshake,
  PairedE2EEDeviceKeyCredential
} from '../../e2ee/paired-e2ee-client-handshake'
import type { InflatedFrame } from '../../e2ee/paired-e2ee-compressed-frame'
import type { RelayClientSocket } from './relay-client-platform'

type ChannelState = 'awaiting-ready' | 'awaiting-authenticated' | 'ready'
type OutboundItem = { kind: 'text'; plaintext: string } | { kind: 'binary'; plaintext: Uint8Array }

export type PairedE2EEClientCredential = PairedE2EEAuthCredential | PairedE2EEDeviceKeyCredential

export class PairedE2EEAuthenticationError extends Error {
  constructor() {
    super('E2EE device authentication rejected')
  }
}

/** One socket's E2EE v2 client: hello, ready, auth, then sealed frames in order. */
export class PairedE2EEV2PhysicalChannel {
  private state: ChannelState = 'awaiting-ready'
  private generation = 0
  private readonly inbound: WsInboundMessageQueue
  private readonly outboundQueue: WsOutboundBackpressureQueue<OutboundItem>

  constructor(
    private readonly args: {
      handshake: PairedE2EEClientHandshake
      socket: Pick<RelayClientSocket, 'OPEN' | 'readyState' | 'bufferedAmount' | 'send'>
      credential: PairedE2EEClientCredential
      // What this client reads, declared in its auth: the host gates methods on them.
      clientCapabilities?: readonly string[]
      decodeBinary: (raw: unknown) => Promise<Uint8Array | null>
      inflateFrame: (frame: Uint8Array) => InflatedFrame | null
      onReadyAccepted?: () => void
      onAuthenticated: () => void
      onText: (plaintext: string) => void
      onBinary: (plaintext: Uint8Array) => void
      onError: (error: Error) => void
    }
  ) {
    if (args.handshake.framing !== 'v2') {
      throw new Error('E2EE v2 physical channel needs a v2 handshake')
    }
    const { channel } = args.handshake
    this.inbound = new WsInboundMessageQueue(
      (raw) => this.processMessage(raw, this.generation),
      (error) => args.onError(asError(error))
    )
    this.outboundQueue = createWsOutboundBackpressureQueue<OutboundItem>({
      // Why: encryption happens only when an admitted item reaches the wire,
      // so a bounded-queue rejection cannot burn an ordered v2 counter.
      send: (item) => {
        args.socket.send(
          item.kind === 'text'
            ? channel.sealText(item.plaintext)
            : channel.sealBinary(item.plaintext)
        )
      },
      byteLengthOf: (item) =>
        (item.kind === 'text'
          ? new TextEncoder().encode(item.plaintext).length
          : item.plaintext.length) + 82,
      getBufferedAmount: () => args.socket.bufferedAmount,
      isWritable: () => args.socket.readyState === args.socket.OPEN,
      onOverflow: () => args.onError(new Error('E2EE v2 outbound buffer overflow'))
    })
  }

  start(): void {
    this.args.socket.send(this.args.handshake.helloText())
  }

  handleMessage(raw: unknown): Promise<void> {
    return this.inbound.enqueue(raw)
  }

  sendText(plaintext: string): boolean {
    return this.enqueueReady({ kind: 'text', plaintext })
  }

  sendBinary(plaintext: Uint8Array): boolean {
    return this.enqueueReady({ kind: 'binary', plaintext })
  }

  dispose(): void {
    this.generation++
    this.inbound.dispose()
    this.outboundQueue.dispose()
  }

  private async processMessage(raw: unknown, generation: number): Promise<void> {
    if (generation !== this.generation) {
      return
    }
    if (this.state === 'awaiting-ready') {
      this.acceptReady(raw, generation)
      return
    }
    const { channel } = this.args.handshake
    const plaintext =
      typeof raw === 'string' ? channel.openText(raw) : await this.openBinary(raw, generation)
    if (generation !== this.generation || plaintext === null) {
      return
    }
    if (this.state === 'awaiting-authenticated') {
      const reply =
        typeof plaintext === 'string' ? this.args.handshake.classifyAuthReply(plaintext) : null
      if (reply?.kind === 'rejected' && reply.type === 'e2ee_error') {
        throw new PairedE2EEAuthenticationError()
      }
      if (reply?.kind !== 'authenticated') {
        throw new Error('Invalid E2EE v2 authenticated response')
      }
      this.state = 'ready'
      this.args.onAuthenticated()
    } else if (typeof plaintext === 'string') {
      this.args.onText(plaintext)
    } else {
      const inflated = this.args.inflateFrame(plaintext)
      if (inflated?.kind === 'text') {
        this.args.onText(inflated.text)
      } else {
        this.args.onBinary(inflated?.bytes ?? plaintext)
      }
    }
  }

  private acceptReady(raw: unknown, generation: number): void {
    if (typeof raw !== 'string') {
      throw new Error('Expected plaintext E2EE v2 ready')
    }
    if (this.args.handshake.acceptReadyText(raw) !== 'accepted') {
      throw new Error('Invalid E2EE v2 ready')
    }
    this.state = 'awaiting-authenticated'
    this.args.onReadyAccepted?.()
    void this.sendAuth(generation)
  }

  // Why direct, not queued: auth is the only frame before authenticated, and a device key signs asynchronously.
  private async sendAuth(generation: number): Promise<void> {
    let frame: string
    try {
      frame = await this.args.handshake.sealAuth(
        this.args.credential,
        this.args.clientCapabilities
          ? { clientCapabilities: this.args.clientCapabilities }
          : undefined
      )
    } catch (error) {
      if (generation === this.generation) {
        this.args.onError(asError(error))
      }
      return
    }
    if (generation !== this.generation) {
      return
    }
    try {
      this.args.socket.send(frame)
    } catch (error) {
      this.args.onError(asError(error))
    }
  }

  private async openBinary(raw: unknown, generation: number): Promise<Uint8Array | null> {
    const bytes = await this.args.decodeBinary(raw)
    if (!bytes || generation !== this.generation) {
      return null
    }
    return this.args.handshake.channel.openBinary(bytes)
  }

  private enqueueReady(item: OutboundItem): boolean {
    if (this.state !== 'ready') {
      return false
    }
    this.outboundQueue.enqueue(item)
    return true
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
