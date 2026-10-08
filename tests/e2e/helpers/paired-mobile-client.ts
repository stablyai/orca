import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from '../../../mobile/src/transport/mobile-runtime-client-capabilities'
import { decodePairingOffer, type PairingOffer } from '../../../src/shared/pairing'
import {
  sendRemoteRuntimeRequest,
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription,
  type RemoteRuntimeSubscriptionCallbacks
} from '../../../src/shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../../src/shared/runtime-rpc-envelope'
import { openRemoteRuntimePassthroughSocket } from '../../../src/shared/remote-runtime-passthrough-socket'
import {
  decodeBrowserScreencastFrame,
  type BrowserScreencastFrame
} from '../../../src/shared/browser-screencast-protocol'
import {
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  TerminalStreamOpcode
} from '../../../src/shared/terminal-stream-protocol'
import type { RuntimeDesktopPairingOffer } from './paired-electron-client'

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * A phone paired to one runtime: the mobile-scoped device token and the phone app's own
 * capability list, over the app's E2EE transport. Each request opens a fresh socket, so requests
 * reach a restarted host; subscriptions do not reconnect across a host restart.
 */
export type PairedMobileClient = {
  /** Raw response, for asserting a refusal. */
  request: <T>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ) => Promise<RuntimeRpcResponse<T>>
  /** Result of a call that must succeed; throws with the host's error code otherwise. */
  call: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>
  subscribe: <T>(
    method: string,
    params: unknown,
    callbacks: RemoteRuntimeSubscriptionCallbacks<T>,
    timeoutMs?: number
  ) => Promise<RemoteRuntimeSubscription>
  /** One persistent phone socket, as the app holds one; needed for streams and `executionHost`. */
  openSocket: () => Promise<PairedMobileSocket>
  /** Closes every subscription and socket this client opened. */
  dispose: () => void
}

/** Raw frames over one authenticated phone socket, exactly as the app writes them. */
export type PairedMobileSocket = {
  token: string
  /** Every text frame received, parsed, in order. */
  frames: { id?: string; ok?: boolean; result?: unknown; error?: { code: string } }[]
  /** Terminal output text per stream id, decoded from binary frames. */
  output: Map<number, string>
  /** Browser screencast frames, decoded from binary frames, in order. */
  screencastFrames: BrowserScreencastFrame[]
  send: (id: string, method: string, params: unknown, executionHost?: string) => void
  /** Resolves the moment `text` appears in the stream's output, so callers can time an echo. */
  waitForOutput: (streamId: number, text: string, timeoutMs: number) => Promise<void>
  close: () => void
}

export function pairMobileClient(offer: RuntimeDesktopPairingOffer): PairedMobileClient {
  const pairing = decodePairingOffer(offer.pairingUrl)
  // Why: a runtime-scope token skips the mobile allowlist, so the oracle would not be a phone.
  if (pairing.scope !== 'mobile') {
    throw new Error(`Expected a mobile-scoped pairing offer, got scope ${String(pairing.scope)}`)
  }
  const open = new Set<{ close: () => void }>()
  const request = <T>(
    method: string,
    params: unknown = {},
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<RuntimeRpcResponse<T>> =>
    sendRemoteRuntimeRequest<T>(
      pairing,
      method,
      params,
      timeoutMs,
      undefined,
      undefined,
      MOBILE_RUNTIME_CLIENT_CAPABILITIES
    )
  return {
    request,
    call: async <T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
      const response = await request<T>(method, params, timeoutMs)
      if (!response.ok) {
        throw new Error(`${method} failed: ${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    subscribe: async (method, params, callbacks, timeoutMs = DEFAULT_TIMEOUT_MS) => {
      const subscription = await subscribeRemoteRuntimeRequest(
        pairing,
        method,
        params,
        timeoutMs,
        callbacks,
        { clientCapabilities: MOBILE_RUNTIME_CLIENT_CAPABILITIES }
      )
      open.add(subscription)
      return subscription
    },
    openSocket: async () => {
      const socket = await openPairedSocket(pairing)
      open.add(socket)
      return socket
    },
    dispose: () => {
      for (const subscription of open) {
        subscription.close()
      }
      open.clear()
    }
  }
}

/** A persistent socket for `pairing` (any scope), speaking the phone's capabilities. */
export async function openPairedSocket(pairing: PairingOffer): Promise<PairedMobileSocket> {
  const frames: PairedMobileSocket['frames'] = []
  const output = new Map<number, string>()
  const screencastFrames: BrowserScreencastFrame[] = []
  const waiters = new Set<() => void>()
  const socket = await openRemoteRuntimePassthroughSocket(
    pairing,
    MOBILE_RUNTIME_CLIENT_CAPABILITIES,
    {
      onText: (plaintext) => frames.push(JSON.parse(plaintext)),
      onBinary: (bytes) => {
        const screencast = decodeBrowserScreencastFrame(bytes)
        if (screencast) {
          screencastFrames.push(screencast)
          return
        }
        const frame = decodeTerminalStreamFrame(bytes)
        if (frame?.opcode === TerminalStreamOpcode.Output) {
          const text = decodeTerminalStreamText(frame.payload)
          output.set(frame.streamId, (output.get(frame.streamId) ?? '') + text)
          for (const check of waiters) {
            check()
          }
        }
      },
      onClose: () => {}
    },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  )
  return {
    token: pairing.deviceToken,
    frames,
    output,
    screencastFrames,
    send: (id, method, params, executionHost) =>
      void socket.send(
        JSON.stringify({ id, deviceToken: pairing.deviceToken, method, params, executionHost })
      ),
    waitForOutput: (streamId, text, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(`stream ${streamId} never printed ${text}`))
        }, timeoutMs)
        const check = (): void => {
          if (output.get(streamId)?.includes(text)) {
            clearTimeout(timer)
            waiters.delete(check)
            resolve()
          }
        }
        waiters.add(check)
        check()
      }),
    close: () => socket.close()
  }
}
