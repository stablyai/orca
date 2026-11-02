import { isWslHookRelayConnectionId, wslHookRelayConnectionId } from './wsl-hook-relay-contract'
import { splitWorktreeIdForFilesystem, worktreeIdsEqual } from './worktree/id'
import { parseWslUncPath } from './wsl-paths'

type TerminalOwner = { connectionId?: string | null; worktreeId?: string }

function wslDistroForWorktree(worktreeId: string | undefined): string | null {
  const worktreePath = worktreeId
    ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    : undefined
  return worktreePath ? (parseWslUncPath(worktreePath)?.distro ?? null) : null
}

export function sameAgentStatusTerminalOwner(
  previous: TerminalOwner,
  incoming: TerminalOwner
): boolean {
  if (
    previous.worktreeId &&
    incoming.worktreeId &&
    !worktreeIdsEqual(previous.worktreeId, incoming.worktreeId)
  ) {
    return false
  }
  if (previous.connectionId === incoming.connectionId) {
    return true
  }
  const relayConnection = isWslHookRelayConnectionId(previous.connectionId)
    ? previous.connectionId
    : isWslHookRelayConnectionId(incoming.connectionId)
      ? incoming.connectionId
      : null
  const localConnection = previous.connectionId === null || incoming.connectionId === null
  if (!relayConnection || !localConnection || !previous.worktreeId || !incoming.worktreeId) {
    return false
  }
  const previousDistro = wslDistroForWorktree(previous.worktreeId)
  const incomingDistro = wslDistroForWorktree(incoming.worktreeId)
  return (
    previousDistro !== null &&
    incomingDistro !== null &&
    previousDistro === incomingDistro &&
    relayConnection === wslHookRelayConnectionId(previousDistro) &&
    worktreeIdsEqual(previous.worktreeId, incoming.worktreeId)
  )
}
