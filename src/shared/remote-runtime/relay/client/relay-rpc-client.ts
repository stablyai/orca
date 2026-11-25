import { isRpcResponse, type RpcResponse } from '../../rpc/rpc-response-shape'
import type { RelayPhoneHello } from '../mobile-relay-phone-protocol'
import type { PairedE2EEClientCredential } from './paired-e2ee-v2-physical-channel'
import type { RelayClientPlatform } from './relay-client-platform'
import { RelayE2eeLink, relayRequestCredentialFields } from './relay-e2ee-link'
import { RelayRpcStreams } from './relay-rpc-streams'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  // Held until the host authenticates; a timeout drops it with the entry.
  unsentFrame: string | null
}

export type RelayRpcClient = {
  sendRequest(method: string, params?: unknown): Promise<RpcResponse>
  /** A host stream on this link; frames reach `listener` until the host ends it or `release`. A
   *  closed link ends it with a `{ type: 'error' }` frame. */
  subscribe(method: string, params: unknown, listener: (result: unknown) => void): () => void
  close(): void
}

export type RelayRpcClientEvents = {
  onOpen?: () => void
  onHello?: (hello: Extract<RelayPhoneHello, { ok: true }>) => void
  onAuthenticated?: () => void
  // Every close, including close(); `intentional` is true only for close().
  onClosed?: (error: Error, intentional: boolean) => void
}

/** Request/reply RPC to a host over one relay link: pairing on an invite, or a short resumed session. */
export function connectRelayRpcClient(
  args: {
    platform: RelayClientPlatform
    endpoint: { cellUrl: string; relayHostId: string }
    credential: string
    expectedCredentialKind: 'invite' | 'resume'
    // A resume dial refuses a hello that accepted another version of this device's credential.
    expectedResumeVersion?: number
    authCredential: PairedE2EEClientCredential
    clientCapabilities?: readonly string[]
    desktopPublicKeyB64: string
    requestTimeoutMs?: number
  },
  events: RelayRpcClientEvents = {}
): RelayRpcClient {
  const requestTimeoutMs = args.requestTimeoutMs ?? 30_000
  const credentialFields = relayRequestCredentialFields(args.authCredential)
  const pending = new Map<string, PendingRequest>()
  let requestCounter = 0
  let closed = false
  let intentionallyClosed = false
  let authenticated = false
  const authenticatedWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>()
  const streams = new RelayRpcStreams({
    nextId: () => `relay-rpc-${++requestCounter}`,
    sendFrame: ({ id, method, params }) =>
      link.sendText(JSON.stringify({ id, ...credentialFields, method, params })),
    waitForConnected: () =>
      authenticated
        ? Promise.resolve()
        : closed
          ? Promise.reject(new Error('relay RPC client closed'))
          : new Promise<void>((resolve, reject) => authenticatedWaiters.add({ resolve, reject }))
  })

  const link = new RelayE2eeLink({
    platform: args.platform,
    endpoint: args.endpoint,
    credential: args.credential,
    expectedCredentialKind: args.expectedCredentialKind,
    authCredential: args.authCredential,
    clientCapabilities: args.clientCapabilities,
    desktopPublicKeyB64: args.desktopPublicKeyB64,
    onOpen: events.onOpen,
    onHello: (hello) => {
      if (
        args.expectedResumeVersion !== undefined &&
        (hello.credentialKind !== 'resume' ||
          hello.acceptedCredentialVersion !== args.expectedResumeVersion)
      ) {
        fail(new Error('relay resume credential version mismatch'))
        return
      }
      events.onHello?.(hello)
    },
    onAuthenticated: () => {
      authenticated = true
      for (const waiter of authenticatedWaiters) {
        waiter.resolve()
      }
      authenticatedWaiters.clear()
      events.onAuthenticated?.()
      for (const [id, request] of pending) {
        if (request.unsentFrame !== null) {
          send(id, request, request.unsentFrame)
        }
      }
    },
    onText: (plaintext) => {
      let value: unknown
      try {
        value = JSON.parse(plaintext)
      } catch {
        return
      }
      if (!isRpcResponse(value) || streams.handleResponse(value)) {
        return
      }
      const request = pending.get(value.id)
      if (request) {
        clearTimeout(request.timer)
        pending.delete(value.id)
        request.resolve(value)
      }
    },
    onBinary: () => {},
    onError: fail
  })

  function send(id: string, request: PendingRequest, frame: string): void {
    request.unsentFrame = null
    if (!link.sendText(frame)) {
      clearTimeout(request.timer)
      pending.delete(id)
      request.reject(new Error('relay E2EE channel not ready'))
    }
  }

  function fail(error: Error): void {
    if (closed) {
      return
    }
    closed = true
    link.close()
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
    for (const waiter of authenticatedWaiters) {
      waiter.reject(error)
    }
    authenticatedWaiters.clear()
    streams.failAll(error.message, error)
    try {
      events.onClosed?.(error, intentionallyClosed)
    } catch {
      // Why: an observer is told after cleanup and must not turn close() into a throw.
    }
  }

  return {
    sendRequest(method, params) {
      if (closed) {
        return Promise.reject(new Error('relay RPC client closed'))
      }
      const id = `relay-rpc-${++requestCounter}`
      let frame: string
      try {
        frame = JSON.stringify({ id, ...credentialFields, method, params })
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return new Promise<RpcResponse>((resolve, reject) => {
        // Why before the auth wait: one budget covers reaching an authenticated host and its reply.
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`relay RPC timed out: ${method}`))
        }, requestTimeoutMs)
        const request: PendingRequest = { resolve, reject, timer, unsentFrame: frame }
        pending.set(id, request)
        if (authenticated) {
          send(id, request, frame)
        }
      })
    },
    subscribe(method, params, listener) {
      return streams.subscribe(method, params, listener).release
    },
    close: () => {
      intentionallyClosed = true
      fail(new Error('relay RPC client closed'))
    }
  }
}
