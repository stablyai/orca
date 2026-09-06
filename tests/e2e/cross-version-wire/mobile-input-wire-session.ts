import type { RpcClient } from '../../../mobile/src/transport/rpc-client'
import type { ConnectionState } from '../../../mobile/src/transport/types'
import nacl from 'tweetnacl'
import WebSocket, { WebSocketServer } from 'ws'
import { RelayPendingRequests } from '../../../mobile/src/transport/relay-pending-requests'
import { inputProofDeadline } from '../../../src/main/runtime/rpc/terminal-ordered-input-pty-test-rig'
import type { TerminalStreamFrame } from './versioned-terminal-wire'
import type { MobileTerminalWireBuild as MobileInputWireBuild } from './versioned-mobile-terminal-wire'

export async function openMobileInputWireSession(
  host: MobileInputWireBuild,
  client: MobileInputWireBuild,
  runtime: unknown,
  options: { dropInputReceipts?: boolean; connectionId?: string } = {}
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  const keys = nacl.box.keyPair()
  const abort = new AbortController()
  const pending = new RelayPendingRequests()
  const dispatches: Promise<unknown>[] = []
  const channels: InstanceType<MobileInputWireBuild['E2EEChannel']>[] = []
  const errors: unknown[] = []
  let socket: WebSocket | undefined
  let mobile: InstanceType<MobileInputWireBuild['MobileE2EEV2PhysicalChannel']> | undefined
  let streams: InstanceType<MobileInputWireBuild['MobileRelayRpcStreams']> | undefined
  let binaryInputs = 0
  let jsonInputs = 0
  let offered: unknown
  let closed = false
  let droppedReceipts = 0
  const listeners = new Set<(state: ConnectionState) => void>()
  const close = () => {
    if (closed) {
      return
    }
    closed = true
    streams?.clear()
    pending.rejectAll(new Error('Mobile skew cleanup'))
    abort.abort()
    mobile?.dispose()
    socket?.terminate()
    for (const channel of channels) {
      channel.destroy()
    }
    for (const peer of server.clients) {
      peer.terminate()
    }
    for (const listener of listeners) {
      listener('disconnected')
    }
  }
  const dispose = async () => {
    close()
    try {
      await inputProofDeadline(Promise.allSettled(dispatches), 'mobile skew dispatcher cleanup')
    } finally {
      await inputProofDeadline(
        new Promise<void>((resolve) => server.close(() => resolve())),
        'mobile skew server cleanup'
      )
    }
  }
  try {
    await inputProofDeadline(
      new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      }),
      'mobile skew listener'
    )
    const dispatcher = new host.RpcDispatcher({
      runtime,
      methods: host.TERMINAL_METHODS
    })
    server.on('connection', (peer) => {
      const handlers = new Map<number, (frame: TerminalStreamFrame) => void>()
      const channel = new host.E2EEChannel(peer, {
        serverSecretKey: keys.secretKey,
        resolveAuthenticatedDevice: (token) =>
          token === 'skew-device'
            ? { deviceId: 'phone', deviceToken: token, scope: 'mobile' }
            : null,
        transportContext: { transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' },
        requireV2: true,
        onReady: () => {},
        onError: (code, reason) => errors.push({ code, reason })
      })
      channels.push(channel)
      channel.onMessage((text, reply, sendBinary) => {
        const request = JSON.parse(text)
        if (request.method === 'terminal.subscribe') {
          offered = request.params?.capabilities
        }
        if (request.method === 'terminal.send') {
          jsonInputs++
        }
        const work = dispatcher.dispatchStreaming(request, reply, {
          connectionId: options.connectionId ?? 'mobile-skew',
          signal: abort.signal,
          clientKind: 'mobile',
          sendBinary: (bytes) => {
            const frame = host.codec.decodeTerminalStreamFrame(bytes)
            const metadata =
              frame?.opcode === host.codec.TerminalStreamOpcode.Metadata
                ? host.codec.decodeTerminalStreamJson<{ inputReceipt?: unknown }>(frame.payload)
                : null
            if (options.dropInputReceipts && metadata?.inputReceipt) {
              droppedReceipts++
              return true
            }
            return sendBinary(bytes)
          },
          registerBinaryStreamHandler: (id, handler) => {
            handlers.set(id, handler)
            return () => {
              handlers.delete(id)
            }
          }
        })
        dispatches.push(work)
        void work.catch((error) => errors.push(error))
      })
      channel.onBinaryMessage((bytes) => {
        const frame = host.codec.decodeTerminalStreamFrame(bytes)
        if (!frame) {
          errors.push(new Error('Host refused a mobile frame'))
          return
        }
        if (frame.opcode === host.codec.TerminalStreamOpcode.Input) {
          binaryInputs++
        }
        handlers.get(frame.streamId)?.(frame)
      })
      peer.on('message', (raw, binary) =>
        channel.handleRawMessage(binary ? new Uint8Array(raw as Buffer) : raw.toString())
      )
      peer.on('error', (error) => errors.push(error))
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Missing skew server port')
    }
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`)
    await inputProofDeadline(
      new Promise<void>((resolve, reject) => {
        socket!.once('open', resolve)
        socket!.once('error', reject)
      }),
      'mobile skew socket'
    )
    let authenticated!: () => void
    const ready = new Promise<void>((resolve) => {
      authenticated = resolve
    })
    streams = new client.MobileRelayRpcStreams({
      nextId: () => pending.nextId(),
      waitForConnected: () => ready,
      sendFrame: (request) => mobile!.sendText(JSON.stringify(request)),
      sendBinary: (bytes) => mobile!.sendBinary(bytes)
    })
    mobile = new client.MobileE2EEV2PhysicalChannel({
      session: client.MobileE2EEV2ClientSession.create({
        desktopPublicKeyB64: Buffer.from(keys.publicKey).toString('base64'),
        transport: 'relay',
        relayHostId: 'AbCdEf0123_-xyZ9'
      }),
      socket,
      deviceToken: 'skew-device',
      decodeBinary: async (raw) => (raw instanceof Uint8Array ? raw : null),
      onAuthenticated: authenticated,
      onText: (text) => {
        const response = JSON.parse(text)
        if (!pending.settle(response)) {
          streams!.handleResponse(response)
        }
      },
      onBinary: (bytes) => streams!.handleBinary(bytes),
      onError: (error) => errors.push(error)
    })
    socket.on('message', (raw, binary) => {
      void mobile!.handleMessage(binary ? new Uint8Array(raw as Buffer) : raw.toString())
    })
    mobile.start()
    await inputProofDeadline(ready, 'mobile skew authentication')
    const rpc: RpcClient = {
      supportsTerminalStreamInput: streams.supportsTerminalStreamInput?.bind(streams),
      sendTerminalStreamInput: streams.sendTerminalStreamInput?.bind(streams),
      getTerminalStreamInputFailure: streams.getTerminalStreamInputFailure?.bind(streams),
      recoverTerminalStreamInput: streams.recoverTerminalStreamInput?.bind(streams),
      cancelTerminalStreamInput: streams.cancelTerminalStreamInput?.bind(streams),
      fenceTerminalStreamInput: streams.fenceTerminalStreamInput?.bind(streams),
      subscribe: (...args) => streams!.subscribe(...args),
      updateTerminalSubscriptionViewport: () => {},
      getState: () => (closed ? 'disconnected' : 'connected'),
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      notifyForeground: () => {},
      close,
      sendRequest: (method, params) => {
        const id = pending.nextId()
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.drop(id)
            reject(new Error('Mobile skew JSON timeout'))
          }, 5000)
          pending.track(id, { resolve, reject, timer })
          try {
            if (!mobile!.sendText(JSON.stringify({ id, method, params }))) {
              throw new Error('Mobile skew JSON send failed')
            }
          } catch (error) {
            clearTimeout(timer)
            pending.drop(id)
            reject(error)
          }
        })
      }
    }
    return {
      rpc,
      dispose,
      errors,
      counts: () => ({ binaryInputs, jsonInputs, droppedReceipts }),
      offered: () => offered
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
