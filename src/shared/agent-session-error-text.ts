// The one way a chat surface turns an agent-session failure into words.
//
// A unary RPC throws an `Error`, but a stream hands its failure over as the raw `{ code, message }`
// payload, and `String()` of that is `[object Object]` — which is what a failed chat used to show.

export function agentSessionErrorText(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof Error) {
    return error.message || fallback
  }
  if (typeof error === 'string') {
    return error || fallback
  }
  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof error.message === 'string' && error.message.length > 0) {
      return error.message
    }
    if ('code' in error && typeof error.code === 'string' && error.code.length > 0) {
      return error.code
    }
  }
  return fallback
}
