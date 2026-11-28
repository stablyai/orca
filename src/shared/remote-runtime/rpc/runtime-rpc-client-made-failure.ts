/** Why: a paired server can answer with the same codes and data this Orca uses when it can't reach it
 *  (the server couldn't reach a third computer), so a failure this Orca made says so. */
const CLIENT_MADE_FAILURE_DATA = { clientMade: true } as const

/** The failure's data, kept as it came, marked as this Orca's own. `unsent` is the transport's proof
 *  that the request never left this computer; without it, whether it arrived is unknown. */
export function clientMadeFailureData(data: unknown, unsent: boolean): Record<string, unknown> {
  return {
    ...(typeof data === 'object' && data !== null ? data : {}),
    ...CLIENT_MADE_FAILURE_DATA,
    ...(unsent ? { requestSent: false } : {})
  }
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
