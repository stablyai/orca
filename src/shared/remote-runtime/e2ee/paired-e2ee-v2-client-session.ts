import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EETransport,
  type MobileE2EEV2Hello
} from './mobile-e2ee-v2-contract'
import { openMobileE2EEV2Frame, sealMobileE2EEV2Frame } from './mobile-e2ee-v2-framing'
import type {
  PairedE2EEKeyPair,
  PairedE2EEPrimitives,
  PairedE2EEV2KeySchedule
} from './paired-e2ee-primitives'

export type PairedE2EEV2ClientSessionArgs = {
  primitives: PairedE2EEPrimitives
  desktopPublicKeyB64: string
  transport: MobileE2EETransport
  relayHostId?: string
  clientNonce?: Uint8Array
  clientKeyPair?: PairedE2EEKeyPair
}

export class PairedE2EEV2ClientSession {
  readonly hello: MobileE2EEV2Hello
  private inboundCounter = 0n
  private outboundCounter = 0n
  private schedule: PairedE2EEV2KeySchedule | null = null
  private transcriptHashB64Value: string | null = null

  private constructor(
    private readonly primitives: PairedE2EEPrimitives,
    private readonly clientSecretKey: Uint8Array,
    private readonly pinnedDesktopPublicKey: Uint8Array,
    hello: MobileE2EEV2Hello
  ) {
    this.hello = hello
  }

  static create(args: PairedE2EEV2ClientSessionArgs): PairedE2EEV2ClientSession {
    const { primitives } = args
    const keyPair = args.clientKeyPair ?? primitives.generateKeyPair()
    const clientNonce = args.clientNonce ?? primitives.randomBytes(32)
    if (clientNonce.length !== 32) {
      throw new Error(`Invalid client nonce length: ${clientNonce.length}`)
    }
    return new PairedE2EEV2ClientSession(
      primitives,
      keyPair.secretKey,
      primitives.publicKeyFromBase64(args.desktopPublicKeyB64),
      {
        type: 'e2ee_hello',
        v: 2,
        clientPublicKeyB64: primitives.publicKeyToBase64(keyPair.publicKey),
        clientNonceB64: primitives.encodeBase64(clientNonce),
        capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
        context: {
          protocol: 'orca-mobile-e2ee',
          initiator: 'mobile',
          responder: 'desktop',
          transport: args.transport,
          ...(args.relayHostId ? { relayHostId: args.relayHostId } : {})
        }
      }
    )
  }

  acceptReady(ready: unknown): boolean {
    const handshake = validateMobileE2EEV2Handshake(this.hello, ready)
    if (!handshake || !equalBytes(handshake.desktopPublicKey, this.pinnedDesktopPublicKey)) {
      return false
    }
    this.schedule = this.primitives.deriveV2KeySchedule({
      sharedSecret: this.primitives.deriveSharedKey(
        this.clientSecretKey,
        this.pinnedDesktopPublicKey
      ),
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    })
    this.transcriptHashB64Value = this.primitives.encodeBase64(this.schedule.transcriptHash)
    return true
  }

  get isReady(): boolean {
    return this.transcriptHashB64Value !== null
  }

  get transcriptHashB64(): string {
    if (!this.transcriptHashB64Value) {
      throw new Error('E2EE v2 ready has not been accepted')
    }
    return this.transcriptHashB64Value
  }

  openText(frameB64: string): string | null {
    const frame = this.decodeCanonicalBase64(frameB64)
    if (!frame) {
      return null
    }
    const plaintext = this.open(frame, 'text')
    if (!plaintext) {
      return null
    }
    return this.primitives.decodeUtf8
      ? this.primitives.decodeUtf8(plaintext)
      : new TextDecoder().decode(plaintext)
  }

  openBinary(frame: Uint8Array): Uint8Array | null {
    return this.open(frame, 'binary')
  }

  sealText(plaintext: string): string {
    return this.primitives.encodeBase64(this.seal(new TextEncoder().encode(plaintext), 'text'))
  }

  sealBinary(plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
    return this.seal(plaintext, 'binary')
  }

  private open(frame: Uint8Array, payloadKind: 'text' | 'binary'): Uint8Array | null {
    if (!this.schedule) {
      return null
    }
    const plaintext = openMobileE2EEV2Frame({
      frame,
      key: this.schedule.desktopToMobileKey,
      sessionId: this.schedule.sessionId,
      direction: 'desktop-to-mobile',
      payloadKind,
      expectedCounter: this.inboundCounter,
      openSecretbox: this.primitives.openSecretbox
    })
    if (plaintext) {
      this.inboundCounter++
    }
    return plaintext
  }

  private seal(plaintext: Uint8Array, payloadKind: 'text' | 'binary'): Uint8Array<ArrayBuffer> {
    if (!this.schedule) {
      throw new Error('E2EE v2 ready has not been accepted')
    }
    const frame = sealMobileE2EEV2Frame({
      payload: plaintext,
      key: this.schedule.mobileToDesktopKey,
      sessionId: this.schedule.sessionId,
      direction: 'mobile-to-desktop',
      payloadKind,
      counter: this.outboundCounter
    })
    this.outboundCounter++
    return frame
  }

  private decodeCanonicalBase64(value: string): Uint8Array | null {
    if (this.primitives.decodeCanonicalBase64) {
      return this.primitives.decodeCanonicalBase64(value)
    }
    try {
      const bytes = this.primitives.decodeBase64(value)
      return this.primitives.encodeBase64(bytes) === value ? bytes : null
    } catch {
      return null
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false
  }
  let difference = 0
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}
