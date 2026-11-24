import type { InflatedFrame } from '../../e2ee/paired-e2ee-compressed-frame'
import type { PairedE2EEPrimitives } from '../../e2ee/paired-e2ee-primitives'

export type RelayClientSocket = {
  readonly OPEN: number
  readonly readyState: number
  readonly bufferedAmount: number
  send: (frame: string | Uint8Array) => void
  close: () => void
}

// Text frames arrive as strings; binary frames in whatever shape decodeBinary reads.
export type RelayClientSocketEvents = {
  onOpen: () => void
  onMessage: (data: unknown) => void
  onError: () => void
  onClose: (code: number, reason: string) => void
}

/** What differs between the phone (Hermes) and desktop (Node) relay clients. */
export type RelayClientPlatform = {
  primitives: PairedE2EEPrimitives
  // Events must start only after createSocket returns, as WebSocket's do.
  createSocket: (url: string, events: RelayClientSocketEvents) => RelayClientSocket
  decodeBinary: (raw: unknown) => Promise<Uint8Array | null>
  // Null for a binary frame that is not compressed; throws on a corrupt one.
  inflateFrame: (frame: Uint8Array) => InflatedFrame | null
  // A client that also dials this host directly latches it so that path never offers legacy framing.
  latchHostToE2EEV2?: (hostPublicKeyB64: string) => void
}
