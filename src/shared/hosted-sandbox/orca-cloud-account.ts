import type { EphemeralVmRuntimeRecord } from '../ephemeral-vm-runtimes'

/**
 * The control-plane account a sandbox token acts for, in sandbox-control's own form
 * (cloud/apps/sandbox-control/src/auth.ts accountIdFor): the selected team pays for its members,
 * otherwise the user is the account. The token is minted for the profile's active org, so
 * `activeOrgId` and the token's `org` claim are the same id.
 */
export function orcaCloudAccountId(
  cloud: { userId?: string | null; activeOrgId?: string | null } | null | undefined
): string | null {
  if (cloud?.activeOrgId) {
    return `org:${cloud.activeOrgId}`
  }
  return cloud?.userId ? `user:${cloud.userId}` : null
}

/**
 * Whether an Orca Cloud runtime belongs to the active team. A record whose team is unknown (or no
 * team is signed in) is not: another team's sandbox must never be listed or kept alive.
 */
export function isOrcaCloudRuntimeInAccount(
  runtime: Pick<EphemeralVmRuntimeRecord, 'cloudAccountId'>,
  activeAccountId: string | null
): boolean {
  return activeAccountId !== null && runtime.cloudAccountId === activeAccountId
}
