// One list for members and invites, in the order people scan it: you, active members, people
// added but not yet signed in, then invites. Pure so the view and its tests share it.
import type {
  OrcaOrgMember,
  OrcaOrgMembersRoster,
  OrcaOrgPendingInvite,
  OrcaOrgRole
} from '../../../../../shared/orca-profiles'
import { canActOnRole } from './team-roles'
import type { TeamMemberStatus } from './team-copy'

export type TeamRow =
  | {
      key: string
      kind: 'member'
      member: OrcaOrgMember
      status: Exclude<TeamMemberStatus, 'invited'>
      self: boolean
      /** The viewer may change this member's role or remove them. */
      manageable: boolean
    }
  | {
      key: string
      kind: 'invite'
      invite: OrcaOrgPendingInvite
      status: 'invited'
      self: false
      manageable: boolean
    }

const ROLE_ORDER: Record<OrcaOrgRole, number> = { owner: 0, admin: 1, member: 2 }

function byName(a: OrcaOrgMember, b: OrcaOrgMember): number {
  return (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email)
}

export function teamRows(roster: OrcaOrgMembersRoster, viewerUserId: string | null): TeamRow[] {
  const isSelf = (member: OrcaOrgMember): boolean =>
    member.userId !== null && member.userId === viewerUserId
  const memberRow = (member: OrcaOrgMember): TeamRow => ({
    key: `member:${member.userId ?? member.email.toLowerCase()}`,
    kind: 'member',
    member,
    status: member.userId === null ? 'pending' : 'active',
    self: isSelf(member),
    manageable:
      roster.canManageMembers &&
      !isSelf(member) &&
      member.userId !== null &&
      canActOnRole(roster.viewerRole, member.role)
  })
  const self = roster.members.filter(isSelf)
  const active = roster.members
    .filter((member) => !isSelf(member) && member.userId !== null)
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || byName(a, b))
  const pending = roster.members.filter((member) => member.userId === null).sort(byName)
  const invites = [...roster.pendingInvites].sort((a, b) => b.createdAt - a.createdAt)
  return [
    ...self.map(memberRow),
    ...active.map(memberRow),
    ...pending.map(memberRow),
    ...invites.map((invite): TeamRow => ({
      key: `invite:${invite.email.toLowerCase()}`,
      kind: 'invite',
      invite,
      status: 'invited',
      self: false,
      manageable: roster.canManageMembers && canActOnRole(roster.viewerRole, invite.role)
    }))
  ]
}

/** Owners other than the viewer: leaving needs one, and "Make owner" creates one. */
export function otherOwnerCount(roster: OrcaOrgMembersRoster, viewerUserId: string | null): number {
  return roster.members.filter(
    (member) => member.role === 'owner' && member.userId !== null && member.userId !== viewerUserId
  ).length
}
