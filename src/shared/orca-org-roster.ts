// A team's roster as auth answers it (GET /v1/desktop/orgs/:orgId/members).
import type { OrcaOrgMember, OrcaOrgPendingInvite, OrcaOrgRole } from './orca-profiles'

export type OrcaOrgMembersRoster = {
  members: OrcaOrgMember[]
  pendingInvites: OrcaOrgPendingInvite[]
  viewerRole: OrcaOrgRole
  canManageMembers: boolean
  /** Directory sync is on: the team's identity provider owns membership and roles. */
  directoryManaged?: boolean
}
