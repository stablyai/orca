import { isRpcResponse, type RpcResponse } from '../../rpc/rpc-response-shape'
import type { RelayPhoneHello } from '../mobile-relay-phone-protocol'
import type { PairedE2EEClientCredential } from './paired-e2ee-v2-physical-channel'
import type { RelayClientPlatform } from './relay-client-platform'
import { RelayE2eeLink, relayRequestCredentialFields } from './relay-e2ee-link'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  // Held until the host authenticates; a timeout drops it with the entry.
  unsentFrame: string | null
}

export type RelayRpcClient = {
  sendRequest(method: string, params?: unknown): Promise<RpcResponse>
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

  const link = new RelayE2eeLink({
    platform: args.platform,
    endpoint: args.endpoint,
    credential: args.credential,
    expectedCredentialKind: args.expectedCredentialKind,
    authCredential: args.authCredential,
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
      if (!isRpcResponse(value)) {
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
    close: () => {
      intentionallyClosed = true
      fail(new Error('relay RPC client closed'))
    }
  }
}
