import { isRpcResponse, type RpcResponse } from '../../rpc/rpc-response-shape'
import type { RelayPhoneHello } from '../mobile-relay-phone-protocol'
import type { PairedE2EEClientCredential } from './paired-e2ee-v2-physical-channel'
import type { RelayClientPlatform } from './relay-client-platform'
import { RelayE2eeLink, relayRequestCredentialFields } from './relay-e2ee-link'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
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
  let resolveAuthenticated!: () => void
  let rejectAuthenticated!: (error: Error) => void
  const authenticatedPromise = new Promise<void>((resolve, reject) => {
    resolveAuthenticated = resolve
    rejectAuthenticated = reject
  })
  // Why: a request is the only consumer; an unawaited failure must not surface as unhandled.
  authenticatedPromise.catch(() => {})

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
      resolveAuthenticated()
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

  function fail(error: Error): void {
    if (closed) {
      return
    }
    closed = true
    events.onClosed?.(error, intentionallyClosed)
    link.close()
    rejectAuthenticated(error)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  return {
    async sendRequest(method, params) {
      await authenticatedPromise
      if (closed || !authenticated) {
        throw new Error('relay RPC client closed')
      }
      const id = `relay-rpc-${++requestCounter}`
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`relay RPC timed out: ${method}`))
        }, requestTimeoutMs)
        pending.set(id, { resolve, reject, timer })
        if (!link.sendText(JSON.stringify({ id, ...credentialFields, method, params }))) {
          clearTimeout(timer)
          pending.delete(id)
          reject(new Error('relay E2EE channel not ready'))
        }
      })
    },
    close: () => {
      intentionallyClosed = true
      fail(new Error('relay RPC client closed'))
    }
  }
}
