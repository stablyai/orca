/**
 * The live PTY ownership-transfer path is a release canary until routed,
 * cross-platform recovery evidence is complete. Keep the opt-in exact and
 * process-scoped so ordinary profiles cannot inherit it accidentally.
 */
export const PTY_OWNERSHIP_TRANSFER_CANARY_ENV =
  'ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION'

export function isPtyOwnershipTransferMutationEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[PTY_OWNERSHIP_TRANSFER_CANARY_ENV] === '1'
}
