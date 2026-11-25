import WebSocket from 'ws'
import { inflateCompressedFrame } from '../../../e2ee/paired-e2ee-compressed-frame'
import { NODE_COMPRESSED_FRAME_CODEC } from '../../../e2ee/node/paired-e2ee-node-compressed-frame'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../e2ee/node/paired-e2ee-node-primitives'
import { remoteRuntimeConnectOptions } from '../../../remote-runtime-connect-bound'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from '../../../remote-runtime-memory-limits'
import { readSealedFrame } from '../../../remote-runtime-sealed-frame'
import type { RelayClientPlatform } from '../relay-client-platform'

/** The desktop relay client: `ws` and node:crypto. It reaches shared hosts only through the relay, which is v2 only. */
export const NODE_RELAY_CLIENT_PLATFORM: RelayClientPlatform = {
  primitives: NODE_PAIRED_E2EE_PRIMITIVES,
  createSocket: (url, events) => {
    const ws = new WebSocket(
      url,
      remoteRuntimeConnectOptions({ maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES })
    )
    ws.on('open', events.onOpen)
    ws.on('message', (data, isBinary) => events.onMessage(readSealedFrame(data, isBinary)))
    ws.on('error', events.onError)
    ws.on('close', (code, reason) => events.onClose(code, reason.toString()))
    return ws
  },
  decodeBinary: async (raw) => (raw instanceof Uint8Array ? raw : null),
  inflateFrame: (frame) => inflateCompressedFrame(frame, NODE_COMPRESSED_FRAME_CODEC)
}
