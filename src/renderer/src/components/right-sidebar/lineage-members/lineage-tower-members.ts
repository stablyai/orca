import type { LineageMember } from '../../../../../shared/lineage-discovery-types'

type ActiveWorktreeIdentity = { id: string | null; path: string | null }

function isTowerMember(member: LineageMember, active: ActiveWorktreeIdentity | null): boolean {
  if (member.isTower) {
    return true
  }
  // why: older hosts send no tower flag, so the active worktree's own member must be recognised by identity
  return Boolean(
    active &&
    ((member.worktreeId && member.worktreeId === active.id) ||
      (member.worktreePath && member.worktreePath === active.path))
  )
}

/** True only when the list holds something besides the workspace itself, so a plain worktree keeps the single panel. */
export function hasMembersBeyondTower(
  members: LineageMember[],
  active: ActiveWorktreeIdentity | null
): boolean {
  return members.some((member) => !isTowerMember(member, active))
}
