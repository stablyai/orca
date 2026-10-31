import type { WebRuntimeClient } from './web-runtime-client'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../shared/protocol-version'
import { vi } from 'vitest'
import { NODE_PAIRED_E2EE_PRIMITIVES as crypto } from '../../../shared/paired-e2ee-node-primitives'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/paired-runtime-connection'
import {
  validateMobileE2EEV2Handshake,
  encodeMobileE2EEV2Transcript
} from '../../../shared/mobile-e2ee-v2-contract'
import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame
} from '../../../shared/mobile-e2ee-v2-framing'
import type { PairedE2EEV2KeySchedule } from '../../../shared/paired-e2ee-primitives'

const host = crypto.generateKeyPair()
export const publicKeyB64 = crypto.publicKeyToBase64(host.publicKey)
export const connection = pairedRuntimeConnectionFromOffer({
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'token',
  publicKeyB64
})

export class CrewSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static sockets: CrewSocket[] = []
  static constructError: Error | undefined
  readyState = CrewSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  close = vi.fn(() => {
    this.readyState = 3
  })
  send = vi.fn((_data: unknown) => {})
  private key: Uint8Array | undefined
  private schedule: PairedE2EEV2KeySchedule | undefined
  private inbound = 0n
  private outbound = 0n

  constructor() {
    if (CrewSocket.constructError) {
      throw CrewSocket.constructError
    }
    CrewSocket.sockets.push(this)
  }

  open(): void {
    this.readyState = CrewSocket.OPEN
    this.onopen?.()
  }

  ready(): void {
    const hello: unknown = JSON.parse(String(this.send.mock.calls[0]?.[0]))
    if (!hello || typeof hello !== 'object') {
      throw new Error('Missing hello')
    }
    if ('v' in hello && hello.v === 2) {
      if (!('clientNonceB64' in hello) || !('context' in hello)) {
        throw new Error('Invalid hello')
      }
      const ready = {
        type: 'e2ee_ready',
        v: 2,
        desktopPublicKeyB64: publicKeyB64,
        clientNonceB64: hello.clientNonceB64,
        desktopNonceB64: crypto.encodeBase64(new Uint8Array(32).fill(4)),
        selection: { framing: 2, payloadKinds: ['text', 'binary'] },
        context: hello.context
      }
      const handshake = validateMobileE2EEV2Handshake(hello, ready)
      if (!handshake) {
        throw new Error('Invalid fixture handshake')
      }
      this.schedule = crypto.deriveV2KeySchedule({
        sharedSecret: crypto.deriveSharedKey(host.secretKey, handshake.clientPublicKey),
        transcript: encodeMobileE2EEV2Transcript(handshake),
        clientNonce: handshake.clientNonce,
        desktopNonce: handshake.desktopNonce
      })
      this.onmessage?.({ data: JSON.stringify(ready) })
    } else {
      if (!('publicKeyB64' in hello) || typeof hello.publicKeyB64 !== 'string') {
        throw new Error('Invalid legacy hello')
      }
      this.key = crypto.deriveSharedKey(
        host.secretKey,
        crypto.publicKeyFromBase64(hello.publicKeyB64)
      )
      this.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) })
    }
  }

  frame(value: unknown): void {
    let data: string
    if (this.schedule) {
      data = crypto.encodeBase64(
        sealMobileE2EEV2Frame({
          payload: new TextEncoder().encode(JSON.stringify(value)),
          key: this.schedule.desktopToMobileKey,
          sessionId: this.schedule.sessionId,
          direction: 'desktop-to-mobile',
          payloadKind: 'text',
          counter: this.outbound++
        })
      )
    } else {
      if (!this.key) {
        throw new Error('No fixture session')
      }
      data = crypto.sealLegacyText(JSON.stringify(value), this.key)
    }
    this.onmessage?.({ data })
  }

  authenticated(): void {
    this.frame({
      type: 'e2ee_authenticated',
      ...(this.schedule
        ? { v: 2, transcriptHashB64: crypto.encodeBase64(this.schedule.transcriptHash) }
        : {})
    })
  }

  read(index: number): unknown {
    const frame = String(this.send.mock.calls[index]?.[0])
    let plaintext: string | null
    if (this.schedule) {
      const bytes = openMobileE2EEV2Frame({
        frame: crypto.decodeBase64(frame),
        key: this.schedule.mobileToDesktopKey,
        sessionId: this.schedule.sessionId,
        direction: 'mobile-to-desktop',
        payloadKind: 'text',
        expectedCounter: this.inbound++
      })
      plaintext = bytes ? new TextDecoder().decode(bytes) : null
    } else {
      plaintext = this.key ? crypto.openLegacyText(frame, this.key) : null
    }
    if (!plaintext) {
      throw new Error('Invalid fixture frame')
    }
    return JSON.parse(plaintext)
  }
}

export function installCrewSocketGlobals(): void {
  CrewSocket.sockets = []
  CrewSocket.constructError = undefined
  vi.stubGlobal('WebSocket', CrewSocket)
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
  })
}

export async function flushCrewWork(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve()
  }
}

export function latestCrewSocket(): CrewSocket {
  const socket = CrewSocket.sockets.at(-1)
  if (!socket) {
    throw new Error('No fixture socket')
  }
  return socket
}

/** Complete the existing primary's real status request over the controlled encrypted socket. */
export async function verifyCrewPrimary(client: WebRuntimeClient): Promise<CrewSocket> {
  const socket = latestCrewSocket()
  socket.open()
  socket.ready()
  await flushCrewWork()
  socket.authenticated()
  await flushCrewWork()
  const request = socket.read(2)
  if (
    !request ||
    typeof request !== 'object' ||
    !('id' in request) ||
    typeof request.id !== 'string' ||
    !('method' in request) ||
    request.method !== 'status.get'
  ) {
    throw new Error('Expected actual primary status request')
  }
  socket.frame({
    id: request.id,
    ok: true,
    result: {
      runtimeId: 'rt',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
    },
    _meta: { runtimeId: 'rt' }
  })
  await flushCrewWork()
  if (client.statusOwner?.read().verification !== 'verified') {
    throw new Error('Primary did not verify')
  }
  return socket
}
