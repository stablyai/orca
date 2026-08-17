import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'

export type TerminalMoveDestinationError =
  | 'destination_same_as_source'
  | 'destination_is_floating'

export function getTerminalMoveDestinationError(
  sourceWorktreeId: string,
  destWorktreeId: string
): TerminalMoveDestinationError | null {
  if (destWorktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'destination_is_floating'
  }
  if (destWorktreeId === sourceWorktreeId) {
    return 'destination_same_as_source'
  }
  return null
}

export function assertValidTerminalMoveDestination(
  sourceWorktreeId: string,
  destWorktreeId: string
): void {
  const error = getTerminalMoveDestinationError(sourceWorktreeId, destWorktreeId)
  if (error) {
    throw new Error(error)
  }
}
