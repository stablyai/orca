import { vi } from 'vitest'
import type { HostTerminalRuntimeStub } from './host-terminal-runtime-stub'
import type { TerminalStreamFrame, TerminalWireBuild } from './versioned-terminal-wire'

export type ObservedFrame = {
  direction: 'host-to-client' | 'client-to-host'
  opcode: number
  streamId: number
  seq: number
  /** JSON payload when the receiving side could parse one. */
  json: Record<string, unknown> | null
  text: string
}

export type RejectedFrame = {
  direction: 'host-to-client' | 'client-to-host'
  /** Opcode byte as written by the sender, even though the receiver refused it. */
  rawOpcode: number
  byteLength: number
}

export type HostConnection = {
  connectionId: string
  events: Record<string, unknown>[]
  alive: boolean
}

export type TerminalWireLink = {
  /** Frames each side accepted, in delivery order. */
  observed: ObservedFrame[]
  /** Frames the receiving build's decoder refused — the unknown-opcode failure mode. */
  rejected: RejectedFrame[]
  connections: HostConnection[]
  /** Drop the live transport the way a socket close would. */
  disconnect: () => void
  dispose: () => Promise<void>
}

function rawOpcodeOf(bytes: Uint8Array): number {
  return bytes.length > 2 ? bytes[2]! : -1
}

function describeFrame(
  direction: ObservedFrame['direction'],
  frame: TerminalStreamFrame,
  codec: TerminalWireBuild['codec']
): ObservedFrame {
  const json = codec.decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
  return {
    direction,
    opcode: frame.opcode,
    streamId: frame.streamId,
    seq: frame.seq,
    json: json && typeof json === 'object' ? json : null,
    text: codec.decodeTerminalStreamText(frame.payload)
  }
}

/**
 * Pair one client build to one host build over an in-process transport that copies
 * the production routing exactly:
 *
 *  - client -> host: the HOST decodes with its own codec and drops the frame when
 *    the opcode is unknown (`runtime-rpc.ts` `handleWebSocketBinaryMessage`);
 *  - host -> client: raw bytes reach the client, which decodes with ITS codec.
 *
 * That asymmetry is the whole point: a frame only survives if the receiving build
 * understands it, so a new opcode against an old peer disappears silently.
 */
export function createTerminalWireLink(args: {
  hostBuild: TerminalWireBuild
  clientBuild: TerminalWireBuild
  hostStub: HostTerminalRuntimeStub
}): TerminalWireLink {
  const { hostBuild, clientBuild, hostStub } = args
  const observed: ObservedFrame[] = []
  const rejected: RejectedFrame[] = []
  const connections: HostConnection[] = []
  const dispatchPromises: Promise<unknown>[] = []
  let connectionCounter = 0

  type LiveConnection = {
    record: HostConnection
    handlers: Map<number, (frame: TerminalStreamFrame) => void>
    clientCallbacks: {
      onResponse: (response: unknown) => void
      onBinary: (bytes: Uint8Array) => void
      onError?: (error: { code?: string; message: string }) => void
      onClose?: () => void
    }
  }
  let live: LiveConnection | null = null
  const closeHostSideByConnection = new Map<string, () => void>()

  const subscribe = async (
    _args: unknown,
    clientCallbacks: LiveConnection['clientCallbacks']
  ): Promise<{ unsubscribe: () => void; sendBinary: (bytes: Uint8Array) => void }> => {
    connectionCounter++
    const connectionId = `cross-version-conn-${connectionCounter}`
    const record: HostConnection = { connectionId, events: [], alive: true }
    const handlers = new Map<number, (frame: TerminalStreamFrame) => void>()
    const connection: LiveConnection = { record, handlers, clientCallbacks }
    connections.push(record)
    live = connection
    const abort = new AbortController()
    const closeHostSide = (): void => {
      record.alive = false
      if (live === connection) {
        live = null
      }
      abort.abort()
      // The socket layer runs the host's registered teardown on close; without it
      // the multiplex handler never settles and the harness would hang, not fail.
      hostStub.closeConnection(connectionId)
    }
    closeHostSideByConnection.set(connectionId, closeHostSide)

    const dispatch = new hostBuild.host.RpcDispatcher({
      runtime: hostStub.runtime,
      methods: hostBuild.host.TERMINAL_METHODS
    }).dispatchStreaming(
      {
        id: `req-${connectionCounter}`,
        authToken: 'cross-version-token',
        method: 'terminal.multiplex',
        params: {}
      },
      (message) => {
        if (!record.alive) {
          return
        }
        const envelope = JSON.parse(message) as Record<string, unknown>
        const result = envelope.result
        if (result && typeof result === 'object') {
          record.events.push(result as Record<string, unknown>)
        }
        clientCallbacks.onResponse(envelope)
      },
      {
        connectionId,
        sendBinary: (bytes) => {
          if (!record.alive) {
            return false
          }
          const asClientSees = clientBuild.codec.decodeTerminalStreamFrame(bytes)
          if (!asClientSees) {
            rejected.push({
              direction: 'host-to-client',
              rawOpcode: rawOpcodeOf(bytes),
              byteLength: bytes.byteLength
            })
          } else {
            observed.push(describeFrame('host-to-client', asClientSees, clientBuild.codec))
          }
          // Bytes always go out; only the receiving decoder decides survival.
          clientCallbacks.onBinary(bytes)
          return true
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => {
            if (handlers.get(streamId) === handler) {
              handlers.delete(streamId)
            }
          }
        },
        signal: abort.signal
      }
    )
    dispatchPromises.push(dispatch.catch(() => {}))

    return {
      unsubscribe: closeHostSide,
      sendBinary: (bytes) => {
        if (!record.alive) {
          return
        }
        const frame = hostBuild.codec.decodeTerminalStreamFrame(bytes)
        if (!frame) {
          rejected.push({
            direction: 'client-to-host',
            rawOpcode: rawOpcodeOf(bytes),
            byteLength: bytes.byteLength
          })
          return
        }
        observed.push(describeFrame('client-to-host', frame, hostBuild.codec))
        handlers.get(frame.streamId)?.(frame)
      }
    }
  }

  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        subscribe: vi.fn(subscribe)
      }
    },
    location: { search: '' }
  })

  return {
    observed,
    rejected,
    connections,
    disconnect: () => {
      const connection = live
      if (!connection) {
        return
      }
      closeHostSideByConnection.get(connection.record.connectionId)?.()
      connection.clientCallbacks.onClose?.()
    },
    dispose: async () => {
      for (const record of connections) {
        closeHostSideByConnection.get(record.connectionId)?.()
      }
      live = null
      clientBuild.client.resetRemoteRuntimeTerminalMultiplexersForTests()
      vi.unstubAllGlobals()
      await Promise.all(dispatchPromises)
    }
  }
}
