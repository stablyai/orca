// Whether the signed-in person can manage the active team's plan: the web console's own rule
// (orca-cloud apps/auth accounts/org-roles.ts canManageMembers, applied on /console/orgs/:id/billing):
// owner or admin, compared case-insensitively; any other or missing role counts as a member. The
// desktop offers Plan & billing only to people the console will let in.
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles/orca-profiles'

export function canManageActiveTeam(status: OrcaProfileAuthStatus | null | undefined): boolean {
  if (status?.state !== 'connected' || !status.cloud?.activeOrgId) {
    return false
  }
  const orgId = status.cloud.activeOrgId
  const role = status.organizations
    ?.find((org) => org.orgId === orgId)
    ?.role?.trim()
    .toLowerCase()
  return role === 'owner' || role === 'admin'
}

/**
 * Whether the signed-in person can choose a plan for what this device shows: an owner or admin of
 * the active team, or a personal account (no team yet), which billing also lets act and whose plan
 * starts by creating a team in the console. Members of a team can only ask an owner or admin.
 * The plans dialog, the account menu's upgrade entry and Settings' Plan & billing all read this, so
 * they agree with each other and with billing's own canManageBilling.
 */
export function canChoosePlan(status: OrcaProfileAuthStatus | null | undefined): boolean {
  if (status?.state !== 'connected') {
    return false
  }
  return !status.cloud?.activeOrgId || canManageActiveTeam(status)
}
