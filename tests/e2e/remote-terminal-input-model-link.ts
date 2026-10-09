import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { TERMINAL_METHODS } from '../../src/main/runtime/rpc/methods/terminal'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../src/shared/terminal-stream-protocol'
import {
  createHostTerminalRuntimeStub,
  type HostTerminalRuntimeStub
} from './cross-version-wire/host-terminal-runtime-stub'

export const MODEL_TERMINAL_HANDLE = 'terminal-1'

/** How one direction of the live connection treats frames: deliver, buffer (a silent link), or lose. */
export type ModelLinkMode = 'pass' | 'hold' | 'drop'

type ClientCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

type Connection = {
  id: string
  host: HostTerminalRuntimeStub
  handlers: Map<number, (frame: TerminalStreamFrame) => void>
  client: ClientCallbacks
  // Frames a silent link buffered; a surviving connection flushes them, a dead one may too, late.
  heldToHost: TerminalStreamFrame[]
  heldToClient: Uint8Array[]
  clientAttached: boolean
  hostAlive: boolean
  lostFrames: boolean
  abort: AbortController
}

/**
 * An in-process remote-runtime socket between the real renderer multiplexer and the real host
 * RPC dispatcher, with the faults a silent outage causes: buffered or lost frames in either
 * direction, a dead connection whose buffered input reaches the host late, and a host runtime
 * that restarts with the PTY surviving.
 */
export function createModelLink(writeInput: (text: string) => Promise<unknown>) {
  let host = newHost()
  let live: Connection | null = null
  const zombies: Connection[] = []
  let counter = 0
  const initialMode: ModelLinkMode = 'pass'
  const link = {
    toHost: initialMode,
    toClient: initialMode,
    /** Drops individual acks on an otherwise healthy connection. */
    ackLoss: 0,
    unreachable: false,
    random: Math.random,
    /** Input frame texts the client handed to any connection, for the oracle. */
    onClientInput: (_text: string): void => {},
    /** Input frame texts that reached a host runtime. */
    onHostInput: (_text: string): void => {},
    subscribe,
    get liveConnected(): boolean {
      return live !== null
    },
    /** Input still buffered toward a host, which may yet arrive (a heal or a late zombie flush). */
    heldInputTexts: (): string[] =>
      [live, ...zombies].flatMap((connection) =>
        (connection?.heldToHost ?? [])
          .filter((frame) => frame.opcode === TerminalStreamOpcode.Input)
          .map((frame) => decodeTerminalStreamText(frame.payload))
      ),
    get zombieCount(): number {
      return zombies.length
    },
    /** The client notices the dead socket; the host side lingers until `retireZombies`. */
    disconnect,
    heal,
    flushZombie,
    retireZombies,
    restartHost,
    dispose: (): void => {
      retireZombies()
      if (live) {
        closeHostSide(live)
      }
    }
  }

  function newHost(): HostTerminalRuntimeStub {
    const stub = createHostTerminalRuntimeStub({
      terminalHandle: MODEL_TERMINAL_HANDLE,
      ptyId: 'pty-1',
      cols: 80,
      rows: 24,
      writeInput
    })
    return stub
  }

  function deliverToHost(connection: Connection, frame: TerminalStreamFrame): void {
    if (!connection.hostAlive || connection.host !== host) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Input) {
      link.onHostInput(decodeTerminalStreamText(frame.payload))
    }
    connection.handlers.get(frame.streamId)?.(frame)
  }

  function deliverToClient(connection: Connection, bytes: Uint8Array): void {
    if (connection.clientAttached) {
      connection.client.onBinary?.(bytes)
    }
  }

  function closeHostSide(connection: Connection): void {
    if (!connection.hostAlive) {
      return
    }
    connection.hostAlive = false
    connection.abort.abort()
    connection.host.closeConnection(connection.id)
  }

  async function subscribe(
    _args: unknown,
    client: ClientCallbacks
  ): Promise<{
    unsubscribe: () => void
    sendBinary: (bytes: Uint8Array) => void
  }> {
    if (link.unreachable) {
      throw Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
        code: 'remote_runtime_unavailable'
      })
    }
    counter += 1
    const connection: Connection = {
      id: `model-conn-${counter}`,
      host,
      handlers: new Map(),
      client,
      heldToHost: [],
      heldToClient: [],
      clientAttached: true,
      hostAlive: true,
      lostFrames: false,
      abort: new AbortController()
    }
    live = connection
    void new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every runtime method the terminal multiplex calls and records any it lacks.
      runtime: host.runtime as OrcaRuntimeService,
      methods: TERMINAL_METHODS
    })
      .dispatchStreaming(
        {
          id: `req-${counter}`,
          authToken: 'model-token',
          method: 'terminal.multiplex',
          params: {}
        },
        (message) => {
          if (connection.clientAttached && connection.hostAlive) {
            client.onResponse(JSON.parse(message))
          }
        },
        {
          connectionId: connection.id,
          sendBinary: (bytes) => {
            if (!connection.hostAlive) {
              return false
            }
            const isAck = decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.InputAck
            if (live === connection && (link.toClient === 'drop' || connection.lostFrames)) {
              connection.lostFrames = true
              return true
            }
            if (live === connection && isAck && link.random() < link.ackLoss) {
              return true
            }
            if (live !== connection || link.toClient === 'hold') {
              connection.heldToClient.push(bytes)
              return true
            }
            deliverToClient(connection, bytes)
            return true
          },
          registerBinaryStreamHandler: (streamId, handler) => {
            connection.handlers.set(streamId, handler)
            return () => {
              if (connection.handlers.get(streamId) === handler) {
                connection.handlers.delete(streamId)
              }
            }
          },
          signal: connection.abort.signal
        }
      )
      .catch(() => {})
    return {
      unsubscribe: () => {
        connection.clientAttached = false
        if (live === connection) {
          live = null
          closeHostSide(connection)
        }
      },
      sendBinary: (bytes) => {
        const frame = decodeTerminalStreamFrame(bytes)
        if (!frame || !connection.clientAttached) {
          return
        }
        if (frame.opcode === TerminalStreamOpcode.Input) {
          link.onClientInput(decodeTerminalStreamText(frame.payload))
        }
        if (live !== connection) {
          return
        }
        // Why stay lost: TCP never delivers a frame after one it lost on the same connection.
        if (link.toHost === 'drop' || connection.lostFrames) {
          connection.lostFrames = true
          return
        }
        if (link.toHost === 'hold') {
          connection.heldToHost.push(frame)
          return
        }
        deliverToHost(connection, frame)
      }
    }
  }

  function disconnect(): void {
    const connection = live
    if (!connection) {
      return
    }
    live = null
    connection.clientAttached = false
    // Why linger: the host has not noticed yet, so buffered input may still reach it late.
    zombies.push(connection)
    link.toHost = 'pass'
    link.toClient = 'pass'
    connection.client.onClose?.()
  }

  /** The silent link recovers before anyone noticed: buffered frames arrive in order. */
  function heal(): void {
    const connection = live
    if (connection?.lostFrames) {
      // Why: a connection that lost frames is gone (TCP never drops mid-stream); only a replacement heals.
      disconnect()
      return
    }
    link.toHost = 'pass'
    link.toClient = 'pass'
    if (!connection) {
      return
    }
    for (const frame of connection.heldToHost.splice(0)) {
      deliverToHost(connection, frame)
    }
    for (const bytes of connection.heldToClient.splice(0)) {
      deliverToClient(connection, bytes)
    }
  }

  /** A dead connection's buffered input reaches the host after the client moved on. */
  function flushZombie(): void {
    const connection = zombies.shift()
    if (!connection) {
      return
    }
    for (const frame of connection.heldToHost.splice(0)) {
      deliverToHost(connection, frame)
    }
    closeHostSide(connection)
  }

  function retireZombies(): void {
    for (const connection of zombies.splice(0)) {
      connection.heldToHost = []
      closeHostSide(connection)
    }
  }

  /** The host runtime restarts; the PTY survives in its daemon, the input ledger does not. */
  function restartHost(): void {
    retireZombies()
    const connection = live
    if (connection) {
      closeHostSide(connection)
    }
    host = newHost()
    if (connection) {
      live = null
      connection.clientAttached = false
      connection.client.onClose?.()
    }
  }

  return link
}
