import type { RoomMember } from './room-types'

const WORKING_TIMEOUT_MS = 15 * 60 * 1000

/** A busy mark survives restarts, but only while its heartbeat is fresh. */
export function activeWorkingMembers(
  members: readonly RoomMember[],
  now = Date.now()
): RoomMember[] {
  return members.filter((member) => {
    if (member.status !== 'working') {
      return false
    }
    const at = Date.parse(member.statusUpdatedAt ?? '')
    return Number.isFinite(at) && now - at < WORKING_TIMEOUT_MS
  })
}

/** An approval/question is durable until answered; there is no stale-busy timeout. */
export function waitingApprovalMembers(members: readonly RoomMember[]): RoomMember[] {
  return members.filter((member) => member.status === 'waiting')
}
