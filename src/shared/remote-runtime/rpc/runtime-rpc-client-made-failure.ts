import type { RuntimeRpcResponse } from './runtime-rpc-envelope'

/** Why: a paired server can answer with the same codes and data this Orca uses when it can't reach it
 *  (the server couldn't reach a third computer), so a failure this Orca made says so. */
const CLIENT_MADE_FAILURE_DATA = { clientMade: true } as const

/** Reserved for this Orca's main process: only it sets them, and it drops them from anything it was
 *  given, so a server's answer (or data it forwarded from another computer) can never carry them. */
const CLIENT_PROVENANCE_KEYS: readonly string[] = ['clientMade', 'requestSent']

/** The failure's data, kept as it came minus any provenance it claims, marked as this Orca's own.
 *  `unsent` is this Orca's own proof that the request never left this computer; without it, whether
 *  it arrived is unknown. */
export function clientMadeFailureData(data: unknown, unsent: boolean): Record<string, unknown> {
  return {
    ...withoutClientProvenance(data),
    ...CLIENT_MADE_FAILURE_DATA,
    ...(unsent ? { requestSent: false } : {})
  }
}

/** A server's answer as this Orca passes it on: its data loses any provenance it claims (see above). */
export function asRemoteAnswer<T>(response: RuntimeRpcResponse<T>): RuntimeRpcResponse<T> {
  if (response.ok || !hasClientProvenance(response.error.data)) {
    return response
  }
  return {
    ...response,
    error: { ...response.error, data: withoutClientProvenance(response.error.data) }
  }
}

function hasClientProvenance(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    CLIENT_PROVENANCE_KEYS.some((key) => Object.hasOwn(data, key))
  )
}

function withoutClientProvenance(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !CLIENT_PROVENANCE_KEYS.includes(key))
  )
}

/** Whether this Orca made the failure itself, never the server it called. */
export function isClientMadeFailure(error: { data?: unknown }): boolean {
  const data = error.data
  return (
    typeof data === 'object' && data !== null && 'clientMade' in data && data.clientMade === true
  )
}

/** This Orca's proof that the request never left it: never read from a server's own answer. */
export function isUnsentClientMadeFailure(error: { data?: unknown }): boolean {
  const data = error.data
  return (
    isClientMadeFailure(error) &&
    typeof data === 'object' &&
    data !== null &&
    'requestSent' in data &&
    data.requestSent === false
  )
}
