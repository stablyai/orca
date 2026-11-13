import type { OrcaOrgRole, OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'

/**
 * The signed-in user's role in the team they are acting as; null when signed out or on a personal
 * account. Auth reports provider role names, so anything but owner/admin reads as member. This
 * only decides what the UI offers: the services check the role on every request.
 */
export function activeTeamRole(
  status: OrcaProfileAuthStatus | null | undefined
): OrcaOrgRole | null {
  if (status?.state !== 'connected') {
    return null
  }
  const orgId = status.cloud?.activeOrgId
  if (!orgId) {
    return null
  }
  const raw = status.organizations
    ?.find((org) => org.orgId === orgId)
    ?.role?.trim()
    .toLowerCase()
  return raw === 'owner' || raw === 'admin' ? raw : 'member'
}

/** Owner or admin of the active team: who sees Settings › Enterprise. */
export function isActiveTeamAdmin(status: OrcaProfileAuthStatus | null | undefined): boolean {
  const role = activeTeamRole(status)
  return role === 'owner' || role === 'admin'
}
