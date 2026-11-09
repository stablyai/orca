/** A host sign-in whose localhost callback this computer listens for and carries to the host. */
export type AuthCallbackForwardRequest = {
  environmentId: string
  flowId: string
  port: number
}

export type AuthCallbackForwardResult =
  | { ok: true }
  | { ok: false; code: 'port_busy' | 'listen_failed' | 'tunnel_failed'; message: string }

// A browser callback is one redirect plus a success page; both ends hold the forward to this.
export const AUTH_CALLBACK_FORWARD_MAX_STREAMS = 8
export const AUTH_CALLBACK_FORWARD_MAX_BYTES = 1024 * 1024
export const AUTH_CALLBACK_FORWARD_TTL_MS = 10 * 60_000
