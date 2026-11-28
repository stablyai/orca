/** Why: a paired server can answer with the same codes this Orca uses when it can't reach it (the
 *  server couldn't reach a third computer), so a failure this Orca made says so. */
export const CLIENT_MADE_FAILURE_DATA = { clientMade: true } as const

/** Whether this Orca made the failure itself, never the server it called. */
export function isClientMadeFailure(error: { data?: unknown }): boolean {
  const data = error.data
  return (
    typeof data === 'object' && data !== null && 'clientMade' in data && data.clientMade === true
  )
}
