import type { WebRuntimeClient } from './web-runtime-client'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../shared/protocol-version'
import { vi } from 'vitest'
import { NODE_PAIRED_E2EE_PRIMITIVES as crypto } from '../../../shared/paired-e2ee-node-primitives'

const host = crypto.generateKeyPair()
export const publicKeyB64 = crypto.publicKeyToBase64(host.publicKey)

export class CrewSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static sockets: CrewSocket[] = []
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

  constructor() {
    CrewSocket.sockets.push(this)
  }

  open(): void {
    this.readyState = CrewSocket.OPEN
    this.onopen?.()
  }

  ready(): void {
    const hello: unknown = JSON.parse(String(this.send.mock.calls[0]?.[0]))
    if (
      !hello ||
      typeof hello !== 'object' ||
      !('publicKeyB64' in hello) ||
      typeof hello.publicKeyB64 !== 'string'
    ) {
      throw new Error('Invalid legacy hello')
    }
    this.key = crypto.deriveSharedKey(
      host.secretKey,
      crypto.publicKeyFromBase64(hello.publicKeyB64)
    )
    this.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) })
  }

  frame(value: unknown): void {
    if (!this.key) {
      throw new Error('No fixture session')
    }
    this.onmessage?.({ data: crypto.sealLegacyText(JSON.stringify(value), this.key) })
  }

  authenticated(): void {
    this.frame({ type: 'e2ee_authenticated' })
  }

  read(index: number): unknown {
    const frame = String(this.send.mock.calls[index]?.[0])
    const plaintext = this.key ? crypto.openLegacyText(frame, this.key) : null
    if (!plaintext) {
      throw new Error('Invalid fixture frame')
    }
    return JSON.parse(plaintext)
  }
}

export function installCrewSocketGlobals(): void {
  CrewSocket.sockets = []
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
